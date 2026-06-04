# Custom IDP Connect Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two-screen "Custom IDP" branch of the Connect-to-Integration-Suite wizard — manual cockpit SAML-trust creation, then automated role-collection assignment + SSO-URL retrieval — working identically in figaf-local (Electron) and figaf-manager (cloud).

**Architecture:** Pure, testable logic (SSO-URL parsing, cockpit-host derivation, trust matching) lives in a new `packages/core/saml-connect.js` module with `node:test` coverage, mirroring the existing `redact-service-key.js` pattern. Four new orchestrator handlers consume that module and are auto-wired into both apps via the `handlers` map; they are exposed on `window.figaf.connect.*` in both `preload.js` and `client.js`. Two shared React screens replace the current custom-IDP stub. No new dependencies, no bundler, no `mode.js` gate.

**Tech Stack:** Node 20, `node:test` + `node:assert/strict` (no test framework), Electron IPC, Express+ws RPC, React 18 via Babel-standalone (no JSX build — screens assign to `window`).

**Spec:** [docs/superpowers/specs/2026-06-04-custom-idp-connect-flow-design.md](../specs/2026-06-04-custom-idp-connect-flow-design.md)

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/saml-connect.js` (new) | Pure functions: `parseSsoUrlFromMetadata(xml)`, `cockpitBaseFromLicense(licenseType)`, `trustConfigUrl({licenseType, gaGuid, subGuid})`, `regionFromLandscape(landscape)`, `findTrustOrigin(trustJson, idpName)`, `classifyAssignResult({code, stdout, stderr})` |
| `packages/core/saml-connect.test.js` (new) | `node:test` coverage for every function above |
| `packages/core/orchestrator.js` (modify) | +4 handlers (`connect:trustConfigUrl`, `connect:resolveIdpOrigin`, `connect:assignPiRole`, `connect:samlSsoUrl`); capture `subaccountSubdomain` / `globalAccountGuid` / `licenseType`; retrofit `xsuaa:assignRoleCollectionPreflight` onto `cockpitBaseFromLicense` |
| `apps/figaf-local/main-process/preload.js` (modify) | extend `connect.*` with 4 methods |
| `apps/figaf-manager/cloud/client.js` (modify) | mirror 4 methods |
| `apps/figaf-manager/cloud/server.js` (modify) | +`app.get("/saml-trust-cockpit.png")` route |
| `packages/ui/app.jsx` (modify) | `connectSteps` derived from `idpMode`; +2 switch cases; extend `ctx.connect` initial state |
| `packages/ui/screens/screen-connect-idp-custom.jsx` (replace) | `ScreenConnectIdpCustomTrust` (Screen A) |
| `packages/ui/screens/screen-connect-idp-custom-assign.jsx` (new) | `ScreenConnectIdpCustomAssign` (Screen B) |
| `packages/ui/index.html` + `apps/figaf-manager/cloud/index.html` (modify) | +`<script>` tag for Screen B |

**Branch:** `feat/custom-idp-connect-flow` (already created; spec already committed there).

---

## Task 1: Pure logic module — `saml-connect.js`

**Files:**
- Create: `packages/core/saml-connect.js`
- Test: `packages/core/saml-connect.test.js`

- [ ] **Step 1: Write the failing test**

Create `packages/core/saml-connect.test.js`:

```js
"use strict";
// Pure-logic tests for the custom-IDP connect flow. No CLI, no network.
// Run via `node --test packages/core/saml-connect.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  regionFromLandscape,
  findTrustOrigin,
  classifyAssignResult,
} = require("./saml-connect");

const SAMPLE_METADATA = `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://9c492946trial.authentication.us10.hana.ondemand.com">
  <md:SPSSODescriptor>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SingleLogout/alias/9c492946trial.aws-live"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SSO/alias/9c492946trial.aws-live" index="0" isDefault="true"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:URI" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/oauth/token/alias/9c492946trial.aws-live" index="1"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

// ── parseSsoUrlFromMetadata ──────────────────────────────────────────────
test("parseSsoUrlFromMetadata extracts the HTTP-POST ACS Location", () => {
  const r = parseSsoUrlFromMetadata(SAMPLE_METADATA);
  assert.equal(r.ssoUrl, "https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SSO/alias/9c492946trial.aws-live");
  assert.equal(r.alias, "9c492946trial.aws-live");
});

test("parseSsoUrlFromMetadata ignores the non-POST (URI) ACS binding", () => {
  const r = parseSsoUrlFromMetadata(SAMPLE_METADATA);
  assert.ok(!r.ssoUrl.includes("/oauth/token/"));
});

test("parseSsoUrlFromMetadata returns null ssoUrl on garbage input", () => {
  const r = parseSsoUrlFromMetadata("<nope/>");
  assert.equal(r.ssoUrl, null);
  assert.equal(r.alias, null);
});

// ── cockpitBaseFromLicense ───────────────────────────────────────────────
test("cockpitBaseFromLicense returns trial host for TRIAL", () => {
  assert.equal(cockpitBaseFromLicense("TRIAL"), "https://cockpit.hanatrial.ondemand.com/trial/");
});

test("cockpitBaseFromLicense returns productive host otherwise", () => {
  assert.equal(cockpitBaseFromLicense("Subscription"), "https://cockpit.btp.cloud.sap/cockpit/");
  assert.equal(cockpitBaseFromLicense(null), "https://cockpit.btp.cloud.sap/cockpit/");
});

// ── trustConfigUrl ───────────────────────────────────────────────────────
test("trustConfigUrl builds the trial deep-link with GUIDs", () => {
  const url = trustConfigUrl({ licenseType: "TRIAL", gaGuid: "GA-1", subGuid: "SUB-2" });
  assert.equal(url, "https://cockpit.hanatrial.ondemand.com/trial/#/globalaccount/GA-1/subaccount/SUB-2/trustConfiguration");
});

test("trustConfigUrl builds the productive deep-link", () => {
  const url = trustConfigUrl({ licenseType: "Subscription", gaGuid: "GA-1", subGuid: "SUB-2" });
  assert.equal(url, "https://cockpit.btp.cloud.sap/cockpit/#/globalaccount/GA-1/subaccount/SUB-2/trustConfiguration");
});

// ── regionFromLandscape ──────────────────────────────────────────────────
test("regionFromLandscape strips the cf- prefix", () => {
  assert.equal(regionFromLandscape("cf-us10"), "us10");
  assert.equal(regionFromLandscape("cf-eu10"), "eu10");
});

test("regionFromLandscape passes through a bare region", () => {
  assert.equal(regionFromLandscape("ap20"), "ap20");
});

test("regionFromLandscape returns null on empty", () => {
  assert.equal(regionFromLandscape(""), null);
  assert.equal(regionFromLandscape(null), null);
});

// ── findTrustOrigin ──────────────────────────────────────────────────────
const TRUST_LIST = [
  { name: "sap.default", originKey: "sap.default", protocol: "OpenID Connect" },
  { name: "figaf-saml", originKey: "idp-5565d868", protocol: "SAML" },
];

test("findTrustOrigin matches by name and returns originKey + list", () => {
  const r = findTrustOrigin(TRUST_LIST, "figaf-saml");
  assert.equal(r.ok, true);
  assert.equal(r.originKey, "idp-5565d868");
  assert.deepEqual(r.all, [
    { name: "sap.default", originKey: "sap.default" },
    { name: "figaf-saml", originKey: "idp-5565d868" },
  ]);
});

test("findTrustOrigin reports not-found with the available names", () => {
  const r = findTrustOrigin(TRUST_LIST, "typo-idp");
  assert.equal(r.ok, false);
  assert.equal(r.originKey, null);
  assert.deepEqual(r.all.map((e) => e.name), ["sap.default", "figaf-saml"]);
});

test("findTrustOrigin handles a {value:[...]} wrapper and a bare array", () => {
  assert.equal(findTrustOrigin({ value: TRUST_LIST }, "figaf-saml").originKey, "idp-5565d868");
  assert.equal(findTrustOrigin(TRUST_LIST, "figaf-saml").originKey, "idp-5565d868");
});

test("findTrustOrigin is defensive against non-array input", () => {
  const r = findTrustOrigin(null, "figaf-saml");
  assert.equal(r.ok, false);
  assert.deepEqual(r.all, []);
});

// ── classifyAssignResult ─────────────────────────────────────────────────
test("classifyAssignResult: exit 0 is ok", () => {
  const r = classifyAssignResult({ code: 0, stdout: "✔ OK", stderr: "" });
  assert.equal(r.ok, true);
  assert.equal(r.sessionExpired, false);
});

test("classifyAssignResult: 'already assigned' on exit 0 is ok+alreadyAssigned", () => {
  const r = classifyAssignResult({ code: 0, stdout: "Role collection already assigned", stderr: "" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyAssigned, true);
});

test("classifyAssignResult: 'Unknown session' sets sessionExpired", () => {
  const r = classifyAssignResult({ code: 1, stdout: "", stderr: "Unknown session. Please log in." });
  assert.equal(r.ok, false);
  assert.equal(r.sessionExpired, true);
  assert.match(r.stderr, /Unknown session/);
});

test("classifyAssignResult: origin-key error surfaces stderr, not session", () => {
  const r = classifyAssignResult({ code: 1, stdout: "", stderr: "error: IDP cannot be found by origin_key: figaf-saml" });
  assert.equal(r.ok, false);
  assert.equal(r.sessionExpired, false);
  assert.match(r.stderr, /origin_key/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/core/saml-connect.test.js`
Expected: FAIL — `Cannot find module './saml-connect'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/saml-connect.js`:

```js
"use strict";
// Pure logic for the custom-IDP connect flow. NO CLI, NO network, NO fs —
// every function here is deterministic and unit-tested in saml-connect.test.js.
// The orchestrator handlers call these; keeping them pure is what lets us test
// the tricky parsing/derivation without spawning btp or hitting the network.

// Extract the Figaf Tool's SSO endpoint from the subaccount's SAML SP metadata.
// We want the AssertionConsumerService with the HTTP-POST binding — its
// Location is the SSO URL (and embeds the landscape-specific `.aws-live` alias
// that no btp CLI command exposes). Returns { ssoUrl, alias } with nulls if the
// metadata can't be parsed.
function parseSsoUrlFromMetadata(xml) {
  const text = typeof xml === "string" ? xml : "";
  const m = text.match(
    /<md:AssertionConsumerService[^>]*Binding="[^"]*HTTP-POST"[^>]*Location="([^"]+)"/
  );
  const ssoUrl = m ? m[1] : null;
  const alias = ssoUrl && ssoUrl.includes("/alias/")
    ? ssoUrl.split("/alias/")[1]
    : null;
  return { ssoUrl, alias };
}

// Trial vs productive cockpit base. licenseType comes from
// `btp get accounts/global-account` (field `licenseType`). "TRIAL" is the
// authoritative trial signal — never sniff the subdomain.
function cockpitBaseFromLicense(licenseType) {
  return licenseType === "TRIAL"
    ? "https://cockpit.hanatrial.ondemand.com/trial/"
    : "https://cockpit.btp.cloud.sap/cockpit/";
}

// Cockpit deep-link to the subaccount's Trust Configuration screen. The
// fragment uses GUIDs (not subdomains) for both global account and subaccount.
function trustConfigUrl({ licenseType, gaGuid, subGuid }) {
  const base = cockpitBaseFromLicense(licenseType);
  return `${base}#/globalaccount/${gaGuid}/subaccount/${subGuid}/trustConfiguration`;
}

// "cf-us10" → "us10"; a bare region passes through; empty → null.
function regionFromLandscape(landscape) {
  if (!landscape) return null;
  return String(landscape).replace(/^cf-/, "");
}

// Find the trust config whose `name` matches idpName and return its originKey.
// Accepts either a bare array or a { value: [...] } wrapper (btp --format json
// returns the wrapper for some objects). `all` is always the [{name,originKey}]
// list so the UI can render a helpful "not found, here's what exists" message.
function findTrustOrigin(trustJson, idpName) {
  const list = Array.isArray(trustJson)
    ? trustJson
    : (trustJson && Array.isArray(trustJson.value) ? trustJson.value : []);
  const all = list.map((e) => ({ name: e.name, originKey: e.originKey }));
  const hit = list.find((e) => e.name === idpName);
  return {
    ok: !!hit,
    originKey: hit ? hit.originKey : null,
    all,
  };
}

// Interpret a `btp assign security/role-collection` result. Exit 0 (including
// a re-assignment that prints "already assigned") is success. "Unknown session"
// is a distinct, recoverable auth-expiry case the UI hints at specially.
function classifyAssignResult({ code, stdout, stderr }) {
  const blob = `${stdout || ""}\n${stderr || ""}`;
  const sessionExpired = /Unknown session/i.test(blob);
  const alreadyAssigned = /already assigned/i.test(blob);
  const tail = (stderr || stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join(" / ");
  return {
    ok: code === 0,
    alreadyAssigned,
    sessionExpired,
    stderr: tail,
  };
}

module.exports = {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  regionFromLandscape,
  findTrustOrigin,
  classifyAssignResult,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/core/saml-connect.test.js`
Expected: PASS — all tests (`# pass <N>`, `# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/saml-connect.js packages/core/saml-connect.test.js
git commit -m "feat(core): pure logic for custom-IDP connect flow

parseSsoUrlFromMetadata, cockpitBaseFromLicense, trustConfigUrl,
regionFromLandscape, findTrustOrigin, classifyAssignResult — all unit
tested via node:test. No CLI/network/fs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Capture extra login state in the orchestrator

**Files:**
- Modify: `packages/core/orchestrator.js` (state object ~line 68; `applySubaccountSelection` ~line 410; `btp:loginStart` close handler ~line 732)

This wires the three state values the new handlers depend on. No new test — these are captured inside CLI-spawning code paths covered by the manual walkthrough; the values they feed are tested in Task 1 (pure) and exercised in Task 3.

- [ ] **Step 1: Add the new state fields**

In the `state` object (after `deployDirResolved: null,` ~line 86), add:

```js
    deployDirResolved: null,
    subaccountSubdomain: null,
    globalAccountGuid: null,
    licenseType: null,
```

- [ ] **Step 2: Capture the subaccount subdomain on selection**

In `applySubaccountSelection` (~line 416), after `state.subaccount = entry.guid;` add:

```js
    state.subaccount = entry.guid;
    state.subaccountSubdomain = entry.subdomain || null;
```

- [ ] **Step 3: Capture GA guid + licenseType at login**

In the `btp:loginStart` close handler, the block that parses the GA JSON (~line 732-734), extend it:

```js
                const data = JSON.parse(gaInfo.stdout.slice(js));
                state.globalAccountSubdomain = data.subdomain || null;
                state.globalAccountGuid = data.guid || null;
                state.licenseType = data.licenseType || null;
                log("btp", "line", `Global account subdomain: ${state.globalAccountSubdomain}`);
```

- [ ] **Step 4: Sanity check (no runtime to assert yet)**

Run: `node -e "require('./packages/core/orchestrator.js'); console.log('require ok')"`
Expected: prints `require ok` (module still parses/loads).

- [ ] **Step 5: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(core): capture subaccountSubdomain, globalAccountGuid, licenseType

These back the custom-IDP connect handlers: the SAML metadata host needs the
subaccount subdomain (not the GA subdomain), the cockpit deep-link needs the
GA GUID, and trial-vs-productive routing needs licenseType.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Four new orchestrator handlers + xsuaa retrofit

**Files:**
- Modify: `packages/core/orchestrator.js` — add `require` for saml-connect (top, ~line 10); add 4 handlers next to `connect:templatePath` (~line 1290); retrofit `xsuaa:assignRoleCollectionPreflight` (~line 1769)

No unit test for the handlers themselves (they spawn `btp` / hit the network — manual-walkthrough territory, consistent with the repo). Their pure dependencies are fully tested in Task 1.

- [ ] **Step 1: Import the pure module**

At the top of `orchestrator.js`, after `const { redactServiceKeyLine } = require("./redact-service-key");` (~line 10):

```js
const { redactServiceKeyLine } = require("./redact-service-key");
const {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  regionFromLandscape,
  findTrustOrigin,
  classifyAssignResult,
} = require("./saml-connect");
```

- [ ] **Step 2: Add a small HTTPS-GET-to-string helper**

The orchestrator has `httpsJson` (parses JSON) and `httpsDownload` (writes to disk) but no "GET text into memory". Add this next to `httpsJson` (~after line 189), reusing the same redirect/UA shape:

```js
  // GET a URL and resolve its body as a string (≤512 KB). Follows up to 5
  // redirects, mirroring httpsDownload. Used to fetch SAML SP metadata.
  function httpsText(url) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      const handle = (currentUrl, hops = 0) => {
        if (hops > 5) { netHandle.end({ error: "too many redirects" }); return reject(new Error("Too many redirects")); }
        https.get(currentUrl, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            return handle(new URL(res.headers.location, currentUrl).href, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            netHandle.end({ status: res.statusCode, error: `HTTP ${res.statusCode}` });
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let data = "";
          res.on("data", (c) => {
            data += c;
            if (data.length > 512 * 1024) { res.destroy(); }
          });
          res.on("end", () => { netHandle.end({ status: 200 }); resolve(data); });
        }).on("error", (err) => { netHandle.end({ error: err }); reject(err); });
      };
      handle(url);
    });
  }
```

- [ ] **Step 3: Add the four handlers**

Immediately after the `connect:templatePath` handler's closing `},` (~line 1290), insert:

```js
    /**
     * Build the cockpit deep-link to this subaccount's Trust Configuration
     * screen, where the operator manually creates the SAML trust. Trial vs
     * productive host derived from state.licenseType (see saml-connect.js).
     */
    async "connect:trustConfigUrl"() {
      const gaGuid = state.globalAccountGuid;
      const subGuid = state.subaccount;
      if (!gaGuid || !subGuid) {
        return { ok: false, error: "global account / subaccount not captured yet (sign in first)" };
      }
      const url = trustConfigUrl({ licenseType: state.licenseType, gaGuid, subGuid });
      return { ok: true, url, isTrial: state.licenseType === "TRIAL" };
    },

    /**
     * List the subaccount's trust configs and resolve the originKey of the one
     * named `idpName`. This is the verify-on-submit call from Screen A — the UI
     * stores the originKey and reuses it on Screen B (does NOT call this again).
     */
    async "connect:resolveIdpOrigin"({ idpName } = {}) {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };
      if (!idpName) return { ok: false, error: "idpName is required" };
      const r = await run(resolveBtp(), ["--format", "json", "list", "security/trust", "--subaccount", sub], { source: "btp" });
      if (r.code !== 0) return { ok: false, error: r.stderr || "list security/trust failed" };
      let parsed;
      try {
        const js = r.stdout.indexOf("[") >= 0 ? r.stdout.indexOf("[") : r.stdout.indexOf("{");
        parsed = js >= 0 ? JSON.parse(r.stdout.slice(js)) : [];
      } catch (e) {
        return { ok: false, error: "could not parse trust list: " + e.message };
      }
      const found = findTrustOrigin(parsed, idpName);
      if (!found.ok) {
        return { ok: false, error: `No SAML trust named "${idpName}" found in this subaccount.`, all: found.all };
      }
      return { ok: true, originKey: found.originKey, all: found.all };
    },

    /**
     * Assign ONE PI role collection to the SAML group for the custom IDP origin.
     * One role per call so the UI owns the loop + per-row state (mirrors
     * ScreenConnectProvision + cf:createService). Uses --of-idp <originKey>
     * --to-group <group> — distinct from xsuaa:assignRoleCollection, which is
     * --to-user against the default IDP.
     */
    async "connect:assignPiRole"({ role, originKey, group } = {}) {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };
      if (!role || !originKey || !group) return { ok: false, error: "role, originKey and group are required" };
      const args = ["assign", "security/role-collection", role, "--subaccount", sub, "--of-idp", originKey, "--to-group", group];
      const r = await run(resolveBtp(), args, { source: "btp" });
      const c = classifyAssignResult(r);
      return { ok: c.ok, alreadyAssigned: c.alreadyAssigned, sessionExpired: c.sessionExpired, stderr: c.stderr, role };
    },

    /**
     * Fetch the subaccount's SAML SP metadata and extract the SSO URL (the
     * AssertionConsumerService HTTP-POST Location). The operator copies this
     * into the Figaf Tool. The `.aws-live` alias inside the URL is not exposed
     * by any btp CLI command, which is why we fetch-and-parse rather than build.
     */
    async "connect:samlSsoUrl"() {
      const subdomain = state.subaccountSubdomain;
      const region = regionFromLandscape(state.landscape);
      if (!subdomain || !region) {
        return { ok: false, error: "subaccount subdomain / region not captured (sign in first)" };
      }
      const url = `https://${subdomain}.authentication.${region}.hana.ondemand.com/saml/metadata`;
      try {
        log("btp", "line", `Fetching SAML metadata: ${url}`);
        const xml = await httpsText(url);
        const { ssoUrl, alias } = parseSsoUrlFromMetadata(xml);
        if (!ssoUrl) return { ok: false, error: "metadata fetched but no HTTP-POST AssertionConsumerService found" };
        return { ok: true, ssoUrl, alias };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
```

- [ ] **Step 4: Retrofit `xsuaa:assignRoleCollectionPreflight`**

Replace the dead-ternary cockpit-host derivation (~line 1776-1782). Find:

```js
      const landscape = state.landscape || "";
      // landscape values: cf-eu10, cf-us10, cf-ap20 … → region: eu10/us10/ap20
      const region = landscape.replace(/^cf-/, "");
      const cockpitHost = region
        ? `cockpit.btp.cloud.sap`
        : `cockpit.btp.cloud.sap`;
      const url = `https://${cockpitHost}/cockpit/?idpId=&globalaccount=${encodeURIComponent(ga)}#/globalaccount/${encodeURIComponent(ga)}/subaccount/${encodeURIComponent(sub)}/users`;
```

Replace with:

```js
      // Trial vs productive cockpit base (see saml-connect.cockpitBaseFromLicense).
      // The previous derivation was a dead ternary that always emitted the
      // productive host even on trial — fixed here via the shared helper.
      const base = cockpitBaseFromLicense(state.licenseType);
      const url = `${base}#/globalaccount/${encodeURIComponent(ga)}/subaccount/${encodeURIComponent(sub)}/users`;
```

- [ ] **Step 5: Verify the module still loads and tests still pass**

Run: `node -e "require('./packages/core/orchestrator.js'); console.log('require ok')" && node --test packages/core/saml-connect.test.js`
Expected: prints `require ok`, then `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/orchestrator.js
git commit -m "feat(core): custom-IDP connect handlers + cockpit-host fix

connect:trustConfigUrl / resolveIdpOrigin / assignPiRole / samlSsoUrl, plus an
httpsText helper. Retrofit xsuaa:assignRoleCollectionPreflight onto the shared
cockpitBaseFromLicense helper (was a dead ternary always emitting prod host).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Expose the 4 methods on both window.figaf shims

**Files:**
- Modify: `apps/figaf-local/main-process/preload.js:98-100`
- Modify: `apps/figaf-manager/cloud/client.js:204-206`

No automated test (these are thin one-line IPC/RPC forwarders; the contract is exercised by the screens in Tasks 5-6 and the manual walkthrough). The check is structural: both shims must expose the identical method set.

- [ ] **Step 1: Extend the Electron preload connect surface**

In `apps/figaf-local/main-process/preload.js`, replace the `connect` block (lines 98-100):

```js
  connect: {
    templatePath: (name) => ipcRenderer.invoke("connect:templatePath", { name }),
    trustConfigUrl: () => ipcRenderer.invoke("connect:trustConfigUrl"),
    resolveIdpOrigin: (idpName) => ipcRenderer.invoke("connect:resolveIdpOrigin", { idpName }),
    assignPiRole: (a) => ipcRenderer.invoke("connect:assignPiRole", a || {}),
    samlSsoUrl: () => ipcRenderer.invoke("connect:samlSsoUrl"),
  },
```

- [ ] **Step 2: Mirror in the cloud client shim**

In `apps/figaf-manager/cloud/client.js`, replace the `connect` block (lines 204-206):

```js
    connect: {
      templatePath:         function (name) { return rpc("connect:templatePath", { name: name }); },
      trustConfigUrl:       function ()     { return rpc("connect:trustConfigUrl"); },
      resolveIdpOrigin:     function (idpName) { return rpc("connect:resolveIdpOrigin", { idpName: idpName }); },
      assignPiRole:         function (a)    { return rpc("connect:assignPiRole", a || {}); },
      samlSsoUrl:           function ()     { return rpc("connect:samlSsoUrl"); },
    },
```

- [ ] **Step 3: Verify both shims expose the same method set**

Run:
```bash
node -e "const s=require('fs').readFileSync('apps/figaf-local/main-process/preload.js','utf8'); const c=require('fs').readFileSync('apps/figaf-manager/cloud/client.js','utf8'); for (const m of ['trustConfigUrl','resolveIdpOrigin','assignPiRole','samlSsoUrl']) { if(!s.includes(m)||!c.includes(m)) throw new Error('missing '+m); } console.log('both shims expose all 4');"
```
Expected: prints `both shims expose all 4`.

- [ ] **Step 4: Commit**

```bash
git add apps/figaf-local/main-process/preload.js apps/figaf-manager/cloud/client.js
git commit -m "feat(apps): expose connect.* custom-IDP methods on both window.figaf shims

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the wizard state machine (app.jsx)

**Files:**
- Modify: `packages/ui/app.jsx` — global comment (line 6-7); `ctx.connect` initial state (~line 97-107); `connectSteps` (~line 144-149); `STEPS` derivation (~line 169-174); `<App/>` switch (~line 199-207)

No automated test — the renderer has no test harness (consistent with the repo; `node:test` is for core/server contracts only). Verification is a manual smoke check in Task 7.

- [ ] **Step 1: Register the two new screen globals**

In the `/* global ... */` comment at the top, update the connect-screen line (line 6-7) to add the two new components:

```js
   ScreenConnectProvision, ScreenConnectIdp,
   ScreenConnectIdpSuser, ScreenConnectIdpPassport, ScreenConnectIdpIas,
   ScreenConnectIdpCustomTrust, ScreenConnectIdpCustomAssign */
```

(Remove the old `ScreenConnectIdpCustom` name — it is replaced by `ScreenConnectIdpCustomTrust`.)

- [ ] **Step 2: Extend the `ctx.connect` initial state**

Replace the `connect: { ... }` initializer (~line 97-107) with:

```js
    connect: {
      marketplaceOk: null,
      tasks: [
        { id: "create-api",   status: "pending", title: "Create it-rt/api service",              sub: "cf create-service it-rt api figaf-api" },
        { id: "create-iflow", status: "pending", title: "Create it-rt/integration-flow service", sub: "cf create-service it-rt integration-flow figaf-iflow" },
        { id: "key-api",      status: "pending", title: "Create + fetch API service key",        sub: "cf create-service-key + cf service-key" },
        { id: "key-iflow",    status: "pending", title: "Create + fetch iFlow service key",      sub: "cf create-service-key + cf service-key" },
      ],
      keys: { api: null, iflow: null },
      idpMode: null,
      // Custom-IDP branch state.
      idpName: "figaf-saml",
      samlGroup: "Admin",
      originKey: null,
      trustList: null,
      piRoles: [
        { id: "PI_Administrator",         status: "pending" },
        { id: "PI_Business_Expert",       status: "pending" },
        { id: "PI_Integration_Developer", status: "pending" },
      ],
      sso: { status: "idle", url: null, alias: null, error: null },
    },
```

- [ ] **Step 3: Make `connectSteps` a function of idpMode**

Replace the static `connectSteps` const (~line 144-149) with a derivation. The custom-IDP tail has two steps; the others keep the single stub:

```js
  const connectTail =
    ctx.connect.idpMode === "custom-idp"
      ? [
          { id: "connect-idp-custom-trust",  label: "Create trust",  sub: "Cockpit SAML config" },
          { id: "connect-idp-custom-assign", label: "Assign & link", sub: "Roles · SSO URL" },
        ]
      : [{ id: "connect-idp-stub", label: "Configure", sub: "Mode-specific setup" }];

  const connectSteps = [
    { id: "connect-provision", label: "Provision",   sub: "it-rt · service keys" },
    { id: "connect-idp",       label: "BTP access",  sub: "Pick auth mode" },
    ...connectTail,
    { id: "done",              label: "Finish",      sub: "Integration Suite linked" },
  ];
```

- [ ] **Step 4: Add the two switch cases and drop the old custom case**

In the `<App/>` switch, find the `connect-idp-stub` case (~line 199-207). It currently handles `custom-idp` by rendering `ScreenConnectIdpCustom`. Remove the `custom-idp` line from that inner switch, and add two new top-level cases. The result:

```js
    case "connect-idp":       Screen = <ScreenConnectIdp ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-idp-stub":
      switch (ctx.connect && ctx.connect.idpMode) {
        case "s-user":       Screen = <ScreenConnectIdpSuser    ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "sap-passport": Screen = <ScreenConnectIdpPassport ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "ias":          Screen = <ScreenConnectIdpIas      ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        default:             Screen = null;
      }
      break;
    case "connect-idp-custom-trust":  Screen = <ScreenConnectIdpCustomTrust  ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-idp-custom-assign": Screen = <ScreenConnectIdpCustomAssign ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
```

- [ ] **Step 5: Verify app.jsx is syntactically valid JSX**

Run (uses the Babel that ships in node_modules via @sap/approuter's tree, falling back to a brace check if absent):
```bash
node -e "const t=require('fs').readFileSync('packages/ui/app.jsx','utf8'); const o=(t.match(/{/g)||[]).length, c=(t.match(/}/g)||[]).length; if(o!==c) throw new Error('brace mismatch '+o+'/'+c); if(t.includes('ScreenConnectIdpCustom ')||/ScreenConnectIdpCustom\b(?!Trust|Assign)/.test(t)) throw new Error('stale ScreenConnectIdpCustom reference'); console.log('app.jsx ok');"
```
Expected: prints `app.jsx ok`.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app.jsx
git commit -m "feat(ui): wire custom-IDP two-screen branch into the wizard machine

connectSteps now derives a two-step tail for idpMode==='custom-idp'; +2 switch
cases; extend ctx.connect with idpName/samlGroup/originKey/trustList/piRoles/sso.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Screen A — `ScreenConnectIdpCustomTrust`

**Files:**
- Replace: `packages/ui/screens/screen-connect-idp-custom.jsx`

- [ ] **Step 1: Replace the stub with Screen A**

Overwrite `packages/ui/screens/screen-connect-idp-custom.jsx`:

```jsx
/* global React, Ico, WizardFooter */

const fgct = () => (typeof window !== "undefined" && window.figaf) || null;
// Logo + this screenshot use the same sibling-relative convention; the cloud
// server adds an explicit /saml-trust-cockpit.png route (see server.js). Use
// the conventional figafModeFlags.isHosted signal (set by mode.js), matching
// how every other screen reads hosted-vs-desktop.
const SAML_SHOT = (typeof window !== "undefined" && window.figafModeFlags && window.figafModeFlags.isHosted)
  ? "/saml-trust-cockpit.png"
  : "./saml-trust-cockpit.png";

// ═══════════════════════════════════════════════════════════
// Connect · 3d-A. Custom IDP — create the SAML trust (manual cockpit step)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustomTrust({ ctx, setCtx, onNext, onBack }) {
  const [url, setUrl] = React.useState(null);
  const [resolving, setResolving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [foundNames, setFoundNames] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  const idpName = ctx.connect.idpName;
  const samlGroup = ctx.connect.samlGroup;

  React.useEffect(() => {
    const api = fgct();
    if (!api) return;
    api.connect.trustConfigUrl().then((r) => { if (r && r.ok) setUrl(r.url); });
  }, []);

  function setField(key, value) {
    setCtx((c) => ({ ...c, connect: { ...c.connect, [key]: value } }));
  }

  async function openCockpit() {
    const api = fgct();
    if (api && url) await api.shell.openExternal(url);
  }

  async function copyUrl() {
    const api = fgct();
    if (!api || !url) return;
    try { await api.shell.writeClipboard(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }

  async function handleNext() {
    const api = fgct();
    if (!api) return;
    const name = (idpName || "").trim();
    if (!name) { setError("Enter the IDP name you created in the cockpit."); return; }
    setResolving(true); setError(null); setFoundNames(null);
    const r = await api.connect.resolveIdpOrigin(name);
    setResolving(false);
    if (!r || !r.ok) {
      setError((r && r.error) || "Could not resolve the IDP origin.");
      if (r && r.all) setFoundNames(r.all.map((e) => e.name));
      return;
    }
    setCtx((c) => ({ ...c, connect: { ...c.connect, originKey: r.originKey, trustList: r.all } }));
    onNext && onNext();
  }

  function handleBack() {
    // Back to the IDP picker — reset custom-IDP inputs to defaults.
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, idpName: "figaf-saml", samlGroup: "Admin", originKey: null, trustList: null },
    }));
    onBack && onBack();
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Create the SAML trust in the cockpit</h1>
          <p className="pane-desc">
            BTP has no CLI to import a SAML trust, so this step is manual. Open the
            Trust Configuration screen, click <strong>New SAML Trust Configuration</strong>
            {" "}(not <em>Establish Trust</em>), upload the file you downloaded from the
            Figaf Tool, and give it a name. Then enter that name below.
          </p>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <button className="btn btn-primary" onClick={openCockpit} disabled={!url}>
              <Ico.Link /> Open Trust Configuration
            </button>
            <button className="btn" onClick={copyUrl} disabled={!url}>
              <Ico.Copy /> {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
          {url && (
            <div style={{ fontSize: 11, color: "var(--ink-3)", wordBreak: "break-all" }}>{url}</div>
          )}
        </div>

        <div className="card" style={{ padding: 12, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: "var(--ink-2)" }}>
            Cockpit reference — how the form should look
          </div>
          <img
            src={SAML_SHOT}
            alt="New SAML Trust Configuration form in the BTP cockpit"
            style={{ width: "100%", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>IDP name</div>
            <input
              className="input"
              value={idpName}
              onChange={(e) => setField("idpName", e.target.value)}
              placeholder="figaf-saml"
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>SAML group</div>
            <input
              className="input"
              value={samlGroup}
              onChange={(e) => setField("samlGroup", e.target.value)}
              placeholder="Admin"
              style={{ width: "100%" }}
            />
          </label>
        </div>

        {error && (
          <div className="card" style={{ padding: 12, marginTop: 14, borderColor: "var(--fg-red, #c0392b)" }}>
            <div style={{ color: "var(--fg-red, #c0392b)", fontSize: 13 }}>{error}</div>
            {foundNames && foundNames.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                Trusts found in this subaccount: {foundNames.join(", ")}. Save your new
                SAML trust in the cockpit, then press Continue again.
              </div>
            )}
          </div>
        )}
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={handleNext}
        nextDisabled={!idpName || !idpName.trim() || resolving}
        nextLabel={resolving ? "Checking…" : "Continue"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustomTrust });
```

- [ ] **Step 2: Verify the file parses (brace balance + global export)**

Run:
```bash
node -e "const t=require('fs').readFileSync('packages/ui/screens/screen-connect-idp-custom.jsx','utf8'); const o=(t.match(/{/g)||[]).length,c=(t.match(/}/g)||[]).length; if(o!==c) throw new Error('brace mismatch '+o+'/'+c); if(!t.includes('ScreenConnectIdpCustomTrust')) throw new Error('missing export'); console.log('Screen A ok');"
```
Expected: prints `Screen A ok`.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/screens/screen-connect-idp-custom.jsx
git commit -m "feat(ui): Screen A — custom-IDP SAML trust creation (cockpit link + name)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Screen B — `ScreenConnectIdpCustomAssign`

**Files:**
- Create: `packages/ui/screens/screen-connect-idp-custom-assign.jsx`

- [ ] **Step 1: Create Screen B**

Create `packages/ui/screens/screen-connect-idp-custom-assign.jsx`:

```jsx
/* global React, Ico, CheckRow, WizardFooter */

const fgca = () => (typeof window !== "undefined" && window.figaf) || null;

const PI_ROLE_TITLES = {
  PI_Administrator:         "Assign PI_Administrator",
  PI_Business_Expert:       "Assign PI_Business_Expert",
  PI_Integration_Developer: "Assign PI_Integration_Developer",
};

// ═══════════════════════════════════════════════════════════
// Connect · 3d-B. Custom IDP — assign PI roles + fetch SSO URL
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustomAssign({ ctx, setCtx, onNext, onBack }) {
  const [started, setStarted] = React.useState(false);
  const piRoles = ctx.connect.piRoles;
  const sso = ctx.connect.sso;
  const originKey = ctx.connect.originKey;
  const group = ctx.connect.samlGroup;

  const markRole = React.useCallback((id, patch) => {
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, piRoles: c.connect.piRoles.map((r) => (r.id === id ? { ...r, ...patch } : r)) },
    }));
  }, [setCtx]);

  const setSso = React.useCallback((patch) => {
    setCtx((c) => ({ ...c, connect: { ...c.connect, sso: { ...c.connect.sso, ...patch } } }));
  }, [setCtx]);

  async function assignOne(role) {
    const api = fgca();
    markRole(role, { status: "running", sub: undefined });
    const r = await api.connect.assignPiRole({ role, originKey, group });
    if (r && r.ok) {
      markRole(role, { status: "done", sub: r.alreadyAssigned ? "already assigned" : `assigned to group "${group}"` });
    } else {
      const hint = r && r.sessionExpired
        ? "BTP session expired — go Back and sign in again"
        : (r && r.stderr) || (r && r.error) || "assign failed";
      markRole(role, { status: "error", sub: hint });
    }
  }

  async function runRoles(ids) {
    for (const id of ids) { await assignOne(id); } // sequential, resilient per-row
  }

  async function fetchSso() {
    const api = fgca();
    setSso({ status: "running", error: null });
    const r = await api.connect.samlSsoUrl();
    if (r && r.ok) setSso({ status: "done", url: r.ssoUrl, alias: r.alias, error: null });
    else setSso({ status: "error", error: (r && r.error) || "could not fetch SSO URL" });
  }

  async function runFlow() {
    setStarted(true);
    await Promise.all([runRoles(piRoles.map((r) => r.id)), fetchSso()]);
  }

  React.useEffect(() => {
    if (!started) runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retryFailedRoles() {
    const failed = piRoles.filter((r) => r.status === "error").map((r) => r.id);
    runRoles(failed);
  }

  function handleBack() {
    // Back to Screen A — clear resolved/derived state so a changed name
    // forces re-resolution.
    setCtx((c) => ({
      ...c,
      connect: {
        ...c.connect,
        originKey: null,
        trustList: null,
        piRoles: c.connect.piRoles.map((r) => ({ id: r.id, status: "pending" })),
        sso: { status: "idle", url: null, alias: null, error: null },
      },
    }));
    onBack && onBack();
  }

  async function copySso() {
    const api = fgca();
    if (!api || !sso.url) return;
    try { await api.shell.writeClipboard(sso.url); } catch {}
  }

  const anyRoleFailed = piRoles.some((r) => r.status === "error");
  const ssoReady = sso.status === "done" && !!sso.url;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 7 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Assign roles &amp; get the SSO URL</h1>
          <p className="pane-desc">
            Assigning the PI role collections to the <span className="kbd">{group}</span> group
            of <span className="kbd">{ctx.connect.idpName}</span>, and fetching the SSO URL
            to paste into the Figaf Tool.
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {piRoles.map((r) => (
              <CheckRow key={r.id} status={r.status} title={PI_ROLE_TITLES[r.id] || r.id} sub={r.sub} />
            ))}
          </div>
        </div>

        {anyRoleFailed && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
            <button className="btn" onClick={retryFailedRoles}><Ico.Refresh /> Retry failed</button>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              You can still finish — unassigned roles can be assigned later in the cockpit.
            </span>
          </div>
        )}

        <div className="divider" />

        <div className="card" style={{ padding: 14, marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>SSO URL (paste into the Figaf Tool)</div>
            {ssoReady && <button className="btn" onClick={copySso}><Ico.Copy /> Copy</button>}
          </div>
          {sso.status === "running" && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Fetching SAML metadata…</div>}
          {sso.status === "error" && (
            <div>
              <div style={{ color: "var(--fg-red, #c0392b)", fontSize: 13, marginBottom: 8 }}>{sso.error}</div>
              <button className="btn" onClick={fetchSso}><Ico.Refresh /> Retry SSO</button>
            </div>
          )}
          {ssoReady && (
            <pre style={{ margin: 0, overflow: "auto", background: "var(--surface-2)", padding: 10, borderRadius: 6, fontSize: 11, lineHeight: 1.4 }}>
{sso.url}
            </pre>
          )}
        </div>
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={onNext}
        nextDisabled={!ssoReady}
        nextLabel={ssoReady ? "Finish" : "Fetching SSO URL…"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustomAssign });
```

- [ ] **Step 2: Verify the file parses**

Run:
```bash
node -e "const t=require('fs').readFileSync('packages/ui/screens/screen-connect-idp-custom-assign.jsx','utf8'); const o=(t.match(/{/g)||[]).length,c=(t.match(/}/g)||[]).length; if(o!==c) throw new Error('brace mismatch '+o+'/'+c); if(!t.includes('ScreenConnectIdpCustomAssign')) throw new Error('missing export'); console.log('Screen B ok');"
```
Expected: prints `Screen B ok`.

- [ ] **Step 3: Confirm CheckRow accepts {status,title,sub}**

Run:
```bash
node -e "const t=require('fs').readFileSync('packages/ui/components.jsx','utf8'); if(!/function CheckRow/.test(t)) throw new Error('CheckRow not found'); console.log('CheckRow present — confirm it reads status/title/sub props');"
```
Expected: prints the confirmation line. If `CheckRow`'s prop names differ from `status`/`title`/`sub`, adjust the `<CheckRow .../>` usage in Step 1 to match (it is used the same way in `screen-connect-provision.jsx` via `{...t}` where `t` has `{id,status,title,sub}`, so these names are correct).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/screens/screen-connect-idp-custom-assign.jsx
git commit -m "feat(ui): Screen B — custom-IDP role assignment + SSO URL retrieval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Register Screen B in both HTML shells + the cloud asset route

**Files:**
- Modify: `packages/ui/index.html:38` (after the custom screen tag)
- Modify: `apps/figaf-manager/cloud/index.html:66` (after the custom screen tag)
- Modify: `apps/figaf-manager/cloud/server.js:208` (after the logo route)

- [ ] **Step 1: Add the script tag to the Electron shell**

In `packages/ui/index.html`, after line 38 (`screen-connect-idp-custom.jsx`):

```html
  <script type="text/babel" src="screens/screen-connect-idp-custom.jsx"></script>
  <script type="text/babel" src="screens/screen-connect-idp-custom-assign.jsx"></script>
```

- [ ] **Step 2: Add the script tag to the cloud shell**

In `apps/figaf-manager/cloud/index.html`, after line 66:

```html
  <script type="text/babel" src="/installer/screens/screen-connect-idp-custom.jsx"></script>
  <script type="text/babel" src="/installer/screens/screen-connect-idp-custom-assign.jsx"></script>
```

- [ ] **Step 3: Add the screenshot route to the cloud server**

In `apps/figaf-manager/cloud/server.js`, after the `/figaf-logo.png` route (line 208):

```js
app.get("/figaf-logo.png", (_req, res) => res.sendFile(path.join(installerDir, "figaf-logo.png")));
app.get("/saml-trust-cockpit.png", (_req, res) => res.sendFile(path.join(installerDir, "saml-trust-cockpit.png")));
```

- [ ] **Step 4: Verify all three edits landed**

Run:
```bash
node -e "const fs=require('fs'); const a=fs.readFileSync('packages/ui/index.html','utf8'), b=fs.readFileSync('apps/figaf-manager/cloud/index.html','utf8'), s=fs.readFileSync('apps/figaf-manager/cloud/server.js','utf8'); if(!a.includes('screen-connect-idp-custom-assign.jsx')) throw new Error('electron shell missing'); if(!b.includes('screen-connect-idp-custom-assign.jsx')) throw new Error('cloud shell missing'); if(!s.includes('/saml-trust-cockpit.png')) throw new Error('asset route missing'); console.log('all 3 registrations present');"
```
Expected: prints `all 3 registrations present`.

- [ ] **Step 5: Confirm the cloud server still boots (test seam)**

Run:
```bash
node -e "process.argv[1]='not-main'; require('./apps/figaf-manager/cloud/server.js'); console.log('server.js requires cleanly');"
```
Expected: prints `server.js requires cleanly` (the `require.main === module` gate prevents listening). If it errors, the edit broke the file — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/index.html apps/figaf-manager/cloud/index.html apps/figaf-manager/cloud/server.js
git commit -m "feat(apps): register Screen B in both shells + serve saml-trust-cockpit.png

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full-suite check + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full core test suite**

Run: `node --test packages/core/`
Expected: all existing tests + the new `saml-connect.test.js` pass (`# fail 0`).

- [ ] **Step 2: Run the figaf-manager test suite (regression — auth gate, server contracts)**

Run: `node --test apps/figaf-manager/cloud/`
Expected: `# fail 0` (no regression from the server.js route addition).

- [ ] **Step 3: Manual smoke test — Electron**

Run: `npm run start:local`
Walk: Welcome → Sign in (BTP+CF) → Choose action → **Connect to Integration Suite** → provision → **BTP access → Custom IDP**.
Verify Screen A: the cockpit link button opens the correct trial/prod deep-link; the screenshot renders; typing a wrong IDP name and pressing Continue shows the "not found, trusts found: …" error; typing `figaf-saml` advances.
Verify Screen B: three role rows resolve (✓ or per-row error + Retry failed); the SSO URL appears and Copy works; Finish is disabled until the SSO URL resolves.

- [ ] **Step 4: Manual smoke test — cloud (optional but recommended)**

Run: `npm run start:manager`, open the printed URL, repeat the Custom IDP walk. Confirm `/saml-trust-cockpit.png` loads (network tab 200) and the screenshot renders.

- [ ] **Step 5: Final commit if any smoke-test fixes were needed**

```bash
git add -A
git commit -m "fix(ui): custom-IDP flow smoke-test corrections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(If no fixes were needed, skip — nothing to commit.)

---

## Notes for the implementer

- **No bundler / no imports in renderer code.** Screens declare `function ScreenX(...)` and end with `Object.assign(window, { ScreenX })`. They reach each other and shared primitives (`React`, `Ico`, `CheckRow`, `WizardFooter`) as globals.
- **`run()` takes an args array** — never string-concatenate `idpName`/`samlGroup`/`role` into a shell command. The handlers in Task 3 already do this correctly.
- **`node:test` only** — do NOT add Jest/Vitest/Mocha. Tests live beside the module (`*.test.js`) and run via `node --test <path>`.
- **The renderer has no automated tests** — that is intentional for this repo. Screen correctness is verified by the manual walkthrough (Task 9 steps 3-4).
- If `CheckRow`, `WizardFooter`, or `Ico.*` prop shapes differ from what Tasks 6-7 assume, match the usage in `screen-connect-provision.jsx` / `screen-choice.jsx` — they are the reference implementations.
```
