# CF Switch Org/Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Switch Org" button to the Cloud Foundry login card that lets the user re-target a different CF org and space without re-authenticating.

**Architecture:** Three new orchestrator handlers run `cf orgs` / `cf target -o` / `cf spaces` / `cf target -o -s` as one-shot commands. The UI reuses the existing org/space picker components, gated by a new `cfSwitchingOrg` boolean that routes `selectCfOrg`/`selectCfSpace` to the new switch handlers instead of the login-flow stdin write.

**Tech Stack:** Node.js (orchestrator), React (no bundler — globals on `window`), Electron IPC + Express/WebSocket RPC

---

## File Map

| File | Change |
|---|---|
| `packages/core/orchestrator.js` | Add 3 state fields, `parseCfList` helper, 3 new handlers |
| `apps/figaf-local/main-process/preload.js` | Expose 3 new `cf.*` IPC methods |
| `apps/figaf-manager/cloud/client.js` | Expose 3 new `cf.*` RPC methods |
| `packages/ui/screens/screen-login.jsx` | `cfSwitchingOrg` state, 2 new functions, modified selectCfOrg/selectCfSpace, new event listener, button, condition changes |

---

## Task 1: Add state fields + `parseCfList` helper to orchestrator

**Files:**
- Modify: `packages/core/orchestrator.js`

- [ ] **Step 1: Add three state fields**

  In `packages/core/orchestrator.js`, locate the `state` object (starts at line 83). After the `licenseType: null,` line (line 105), add:

  ```js
    cfSwitchOrgList: null,
    cfSwitchSelectedOrg: null,
    cfSwitchSpaceList: null,
  ```

  The `state` object should end:
  ```js
    licenseType: null,
    cfSwitchOrgList: null,
    cfSwitchSelectedOrg: null,
    cfSwitchSpaceList: null,
  };
  ```

- [ ] **Step 2: Add `parseCfList` helper function**

  After `runTargetHierarchy` ends (around line 529) and before the `// ─── handlers ───` comment, insert:

  ```js
  // Parse `cf orgs` / `cf spaces` output into a plain string array.
  // Skips: "Getting X as Y..." header, "OK" (CLI v7), "name" (CLI v8 header),
  // separator lines (---), and blank lines. Every remaining non-empty line is an entry.
  function parseCfList(stdout) {
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^getting /i.test(l) &&
          l !== "OK" &&
          l.toLowerCase() !== "name" &&
          !/^-+$/.test(l)
      );
  }
  ```

- [ ] **Step 3: Verify the file still parses**

  ```
  node -e "require('./packages/core/orchestrator.js')" 
  ```
  Expected: no output (no syntax errors).

---

## Task 2: Add `cf:switchOrgStart` handler

**Files:**
- Modify: `packages/core/orchestrator.js`

- [ ] **Step 1: Insert handler**

  After the `cf:targetOrgSpace` handler closes (after line 1244 — the line `},` that ends `cf:targetOrgSpace`) and before `cf:domains`, insert:

  ```js
    async "cf:switchOrgStart"() {
      const r = await run(resolveCf(), ["orgs"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr || "cf orgs failed" };
      const orgs = parseCfList(r.stdout);
      if (orgs.length === 0) return { ok: false, error: "No orgs found" };
      state.cfSwitchOrgList = orgs;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      send("cf:orgChoice", {
        orgs: orgs.map((name, i) => ({
          index: i + 1,
          name,
          recommended: !!(state.org && name === state.org),
        })),
      });
      return { ok: true };
    },
  ```

- [ ] **Step 2: Verify the file still parses**

  ```
  node -e "require('./packages/core/orchestrator.js')"
  ```
  Expected: no output.

---

## Task 3: Add `cf:switchSelectOrg` handler

**Files:**
- Modify: `packages/core/orchestrator.js`

- [ ] **Step 1: Insert handler** (immediately after `cf:switchOrgStart`)

  ```js
    async "cf:switchSelectOrg"({ index }) {
      const orgName = (state.cfSwitchOrgList || [])[Number(index) - 1];
      if (!orgName) return { ok: false, error: "Unknown org index" };
      const t = await run(resolveCf(), ["target", "-o", orgName], { source: "cf" });
      if (t.code !== 0) return { ok: false, error: t.stderr || "cf target -o failed" };
      state.cfSwitchSelectedOrg = orgName;
      const sr = await run(resolveCf(), ["spaces"], { source: "cf" });
      if (sr.code !== 0) return { ok: false, error: sr.stderr || "cf spaces failed" };
      const spaces = parseCfList(sr.stdout);
      if (spaces.length === 0) return { ok: false, error: "No spaces found in org" };
      state.cfSwitchSpaceList = spaces;
      send("cf:spaceChoice", {
        spaces: spaces.map((name, i) => ({ index: i + 1, name })),
      });
      return { ok: true };
    },
  ```

- [ ] **Step 2: Verify parse**

  ```
  node -e "require('./packages/core/orchestrator.js')"
  ```

---

## Task 4: Add `cf:switchSelectSpace` handler + commit orchestrator

**Files:**
- Modify: `packages/core/orchestrator.js`

- [ ] **Step 1: Insert handler** (immediately after `cf:switchSelectOrg`)

  ```js
    async "cf:switchSelectSpace"({ index }) {
      const org = state.cfSwitchSelectedOrg;
      const spaceName = (state.cfSwitchSpaceList || [])[Number(index) - 1];
      if (!org) return { ok: false, error: "No org selected for switch" };
      if (!spaceName) return { ok: false, error: "Unknown space index" };
      const t = await run(resolveCf(), ["target", "-o", org, "-s", spaceName], { source: "cf" });
      if (t.code !== 0) return { ok: false, error: t.stderr || "cf target -o -s failed" };
      state.org = org;
      state.space = spaceName;
      state.cfSwitchOrgList = null;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      send("cf:switchOrgDone", { org, space: spaceName });
      return { ok: true };
    },
  ```

- [ ] **Step 2: Verify parse**

  ```
  node -e "require('./packages/core/orchestrator.js')"
  ```
  Expected: no output.

- [ ] **Step 3: Commit orchestrator changes**

  ```bash
  git add packages/core/orchestrator.js
  git commit -m "feat(cf): add switchOrg/switchSelectOrg/switchSelectSpace handlers"
  ```

---

## Task 5: Expose new IPC methods in preload.js and client.js

**Files:**
- Modify: `apps/figaf-local/main-process/preload.js`
- Modify: `apps/figaf-manager/cloud/client.js`

- [ ] **Step 1: Add to preload.js**

  In `apps/figaf-local/main-process/preload.js`, locate the `cf:` section. After the `targetOrgSpace` line:
  ```js
  targetOrgSpace: () => ipcRenderer.invoke("cf:targetOrgSpace"),
  ```
  Add:
  ```js
  switchOrgStart:   ()      => ipcRenderer.invoke("cf:switchOrgStart"),
  switchSelectOrg:  (index) => ipcRenderer.invoke("cf:switchSelectOrg", { index }),
  switchSelectSpace:(index) => ipcRenderer.invoke("cf:switchSelectSpace", { index }),
  ```

- [ ] **Step 2: Add to client.js**

  In `apps/figaf-manager/cloud/client.js`, locate the `cf:` section. After the `targetOrgSpace:` line:
  ```js
  targetOrgSpace:       function ()  { return rpc("cf:targetOrgSpace"); },
  ```
  Add:
  ```js
  switchOrgStart:       function ()      { return rpc("cf:switchOrgStart"); },
  switchSelectOrg:      function (index) { return rpc("cf:switchSelectOrg", { index: index }); },
  switchSelectSpace:    function (index) { return rpc("cf:switchSelectSpace", { index: index }); },
  ```

- [ ] **Step 3: Verify both files parse**

  ```
  node -e "require('./apps/figaf-local/main-process/preload.js')" 2>&1 | head -5
  ```
  Expected: error about `contextBridge` not defined (Electron-only module) — that's fine, it means the file parsed without syntax errors. The error won't mention the new lines.

  ```
  node -e "require('./apps/figaf-manager/cloud/client.js')" 2>&1 | head -5
  ```
  Expected: no output (it's a plain IIFE, runs fine in Node).

- [ ] **Step 4: Commit**

  ```bash
  git add apps/figaf-local/main-process/preload.js apps/figaf-manager/cloud/client.js
  git commit -m "feat(cf): expose switchOrgStart/switchSelectOrg/switchSelectSpace on window.figaf"
  ```

---

## Task 6: Add cfSwitchingOrg state, new functions, and event listener

**Files:**
- Modify: `packages/ui/screens/screen-login.jsx`

- [ ] **Step 1: Add `cfSwitchingOrg` state**

  In `screen-login.jsx`, after line 14 (`const [spaceChoice, setSpaceChoice] = React.useState(null);`), add:

  ```js
  const [cfSwitchingOrg, setCfSwitchingOrg] = React.useState(false);
  ```

- [ ] **Step 2: Add `switchCfOrg` function**

  After `handleCfLogout` closes (after line ~177), add:

  ```js
  async function switchCfOrg() {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    setSpaceChoice(null);
    setCfSwitchingOrg(true);
    const r = await api.cf.switchOrgStart();
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to list orgs" }]);
      setCfSwitchingOrg(false);
    }
  }
  ```

- [ ] **Step 3: Add `cancelCfSwitch` function** (immediately after `switchCfOrg`)

  ```js
  function cancelCfSwitch() {
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
  }
  ```

- [ ] **Step 4: Add `cf:switchOrgDone` event listener in `useEffect`**

  Inside the `useEffect` callback, after the existing `offCfSpaceChoice` line (line ~38), add:

  ```js
  const offSwitchDone = api.on("cf:switchOrgDone", ({ org, space }) => {
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin(l => ({ ...l, org, space }));
  });
  ```

  In the cleanup `return () => { ... }` block at the bottom of the same `useEffect`, add:
  ```js
  offSwitchDone && offSwitchDone();
  ```

---

## Task 7: Modify selectCfOrg + selectCfSpace, update conditions, add button and cancel

**Files:**
- Modify: `packages/ui/screens/screen-login.jsx`

- [ ] **Step 1: Replace `selectCfOrg`**

  Replace the entire existing `selectCfOrg` function (lines 179–188):

  ```js
  async function selectCfOrg(index) {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectOrg(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectOrg(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
      setLogin({ cfStatus: "error" });
    }
  }
  ```

- [ ] **Step 2: Replace `selectCfSpace`**

  Replace the entire existing `selectCfSpace` function (lines 190–199):

  ```js
  async function selectCfSpace(index) {
    const api = fg();
    if (!api) return;
    setSpaceChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectSpace(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectSpace(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
      setLogin({ cfStatus: "error" });
    }
  }
  ```

- [ ] **Step 3: Add "Switch Org" button to CF card header**

  After the existing "Sign out" button block (lines 448–452):
  ```jsx
  {cfLoggedIn && (
    <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleCfLogout}>
      Sign out
    </button>
  )}
  ```
  Add immediately after:
  ```jsx
  {cfLoggedIn && !cfSwitchingOrg && (
    <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={switchCfOrg}>
      <Ico.Refresh /> Switch Org
    </button>
  )}
  ```

- [ ] **Step 4: Update passcode section condition**

  Line 455 currently reads:
  ```jsx
  {btpLoggedIn && !cfLoggedIn && (
  ```
  Change to:
  ```jsx
  {btpLoggedIn && !cfLoggedIn && !cfSwitchingOrg && (
  ```

- [ ] **Step 5: Update org picker condition**

  Line 513 currently reads:
  ```jsx
  {!cfLoggedIn && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
  ```
  Change to:
  ```jsx
  {(!cfLoggedIn || cfSwitchingOrg) && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
  ```

- [ ] **Step 6: Add cancel button inside org picker** (switch flow only)

  At the bottom of the org picker `div` — after the `</div>` that closes the list of org buttons and before the closing `</div>` of the picker container — add:

  ```jsx
  {cfSwitchingOrg && (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
        Cancel
      </button>
    </div>
  )}
  ```

  The org picker container in the existing code ends with:
  ```jsx
              </div>
            </div>
            </ScrollReveal>
          )}
  ```
  Insert the cancel block just before that final `</div>` (after the list `</div>`).

- [ ] **Step 7: Update space picker condition**

  Line 549 currently reads:
  ```jsx
  {!cfLoggedIn && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
  ```
  Change to:
  ```jsx
  {(!cfLoggedIn || cfSwitchingOrg) && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
  ```

- [ ] **Step 8: Add cancel button inside space picker** (same pattern as org)

  At the bottom of the space picker `div`, before its closing `</div>` / `</ScrollReveal>` / `)}`:

  ```jsx
  {cfSwitchingOrg && (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
        Cancel
      </button>
    </div>
  )}
  ```

- [ ] **Step 9: Commit UI changes**

  ```bash
  git add packages/ui/screens/screen-login.jsx
  git commit -m "feat(ui): add Switch Org button and cf org/space re-targeting flow"
  ```

---

## Task 8: Manual end-to-end verification

- [ ] **Step 1: Start the app**

  ```
  npm --workspace apps/figaf-local start
  ```
  (Or launch `apps/figaf-local` in Electron dev mode — see project README.)

- [ ] **Step 2: Verify "Switch Org" button visibility**

  - Complete BTP login + CF login (org + space selected, summary grid shows).
  - Confirm "Switch Org" button appears in the CF card header next to "Sign out".
  - Confirm "Switch Org" button is absent before CF login is complete.

- [ ] **Step 3: Verify org picker shows correctly**

  - Click "Switch Org".
  - Confirm the terminal drawer logs `cf orgs`.
  - Confirm the org picker renders (same style as login-flow picker).
  - Confirm the current org has the "Recommended" pill.
  - Confirm "Switch Org" button and passcode section are both hidden.
  - Confirm "Cancel" button is visible in the picker.

- [ ] **Step 4: Verify cancel**

  - Click "Cancel".
  - Confirm org picker disappears, summary grid is back, "Switch Org" button re-appears.

- [ ] **Step 5: Verify full switch flow**

  - Click "Switch Org", select an org.
  - Confirm terminal logs `cf target -o <org>` then `cf spaces`.
  - Confirm space picker renders.
  - Select a space.
  - Confirm terminal logs `cf target -o <org> -s <space>`.
  - Confirm summary grid updates with new org and space values.
  - Confirm "Switch Org" button re-appears.

- [ ] **Step 6: Verify error path**

  - While offline (or with cf CLI not targeted), click "Switch Org".
  - Confirm the terminal drawer shows the error line.
  - Confirm `cfSwitchingOrg` resets (summary grid and "Switch Org" button re-appear).
