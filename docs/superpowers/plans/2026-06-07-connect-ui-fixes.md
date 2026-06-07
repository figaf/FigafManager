# Connect UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two UI issues on the Connect to Integration Suite flow: strip the `credentials` wrapper from service key display (Step 4), and halve the cockpit reference image + remove the editable SAML group field (Step 6).

**Architecture:** Both fixes are pure UI-layer changes in the React screens under `packages/ui/screens/`. No orchestrator or host adapter changes required. Each fix is isolated to a single JSX file.

**Tech Stack:** React (no bundler — globals on `window`), plain CSS custom properties, no test runner in this project (manual visual verification).

---

## Task 1: Strip `credentials` wrapper from service key display

**Files:**
- Modify: `packages/ui/screens/screen-connect-provision.jsx` — `KeyCard` component (lines 190–222)

### Context

The `KeyCard` component currently displays the raw CF CLI output or full JSON, which includes an outer `credentials` key:
```json
{
  "credentials": {
    "oauth": { ... }
  }
}
```

The desired output omits that wrapper and shows only the inner object:
```json
{
  "oauth": { ... }
}
```

The `keyData` object stored in context has shape `{ json: <parsed CF response>, raw: <raw string> }`. The parsed JSON's top-level key is `credentials`. We must strip it before display (and before copy).

### Steps

- [ ] **Step 1: Open the file and locate `KeyCard`**

  File: `packages/ui/screens/screen-connect-provision.jsx`, lines 190–222.

- [ ] **Step 2: Replace the `text` computation in `KeyCard`**

  Current (line 193):
  ```js
  const text = keyData.raw || JSON.stringify(keyData.json, null, 2);
  ```

  Replace with:
  ```js
  const displayJson = keyData.json?.credentials ?? keyData.json;
  const text = JSON.stringify(displayJson, null, 2);
  ```

  This always uses the parsed JSON (ignoring `raw`), and unwraps `credentials` when present. If for some reason the CF CLI returns a JSON without a `credentials` key, `?? keyData.json` is the safe fallback.

- [ ] **Step 3: Verify visually**

  Run the app and navigate to the Connect flow → Step 4 · Provision. After services provision, confirm each key card shows:
  ```json
  {
    "oauth": {
      "clientid": "...",
      "clientsecret": "...",
      ...
    }
  }
  ```
  Not wrapped in `{ "credentials": { ... } }`.

  Also verify the Copy button copies the same stripped JSON.

- [ ] **Step 4: Commit**

  ```bash
  git add packages/ui/screens/screen-connect-provision.jsx
  git commit -m "fix(connect): strip credentials wrapper from service key display"
  ```

---

## Task 2: Halve cockpit image size and remove SAML group field

**Files:**
- Modify: `packages/ui/screens/screen-connect-idp-custom.jsx` — image style (line 107) and SAML group field block (lines 111–132)

### Context

Step 6 · BTP access · Custom IDP screen has:
1. A cockpit reference screenshot rendered at `width: "100%"` — should be half size with natural aspect ratio preserved.
2. A two-column grid with "IDP name" and "SAML group" inputs — SAML group should always be `"Admin"` (already the context default), so remove its field entirely and simplify the layout.

### Steps

- [ ] **Step 1: Open the file and locate the image**

  File: `packages/ui/screens/screen-connect-idp-custom.jsx`, line 104–108:
  ```jsx
  <img
    src={SAML_SHOT}
    alt="New SAML Trust Configuration form in the BTP cockpit"
    style={{ width: "100%", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
  />
  ```

- [ ] **Step 2: Change the image style to half-size with preserved aspect ratio**

  Replace the `style` prop:
  ```jsx
  <img
    src={SAML_SHOT}
    alt="New SAML Trust Configuration form in the BTP cockpit"
    style={{ width: "50%", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
  />
  ```

  `width: "50%"` with no explicit `height` preserves the natural aspect ratio automatically.

- [ ] **Step 3: Remove the SAML group field and simplify the layout**

  Current block (lines 111–132):
  ```jsx
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
  ```

  Replace with (drop the grid wrapper and the SAML group label entirely):
  ```jsx
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
  ```

  The `samlGroup` variable is no longer read in the JSX, so remove its destructuring from the top of the component (line 23):
  ```js
  // Remove this line:
  const samlGroup = ctx.connect.samlGroup;
  ```

  The `samlGroup` value in context (`"Admin"`) is still set as the default in `handleBack` — leave that unchanged so downstream steps that read `ctx.connect.samlGroup` continue to receive `"Admin"`.

- [ ] **Step 4: Verify visually**

  Run the app and navigate to Step 6 · BTP access · Custom IDP. Confirm:
  - The cockpit screenshot is roughly half the width it was (no distortion).
  - Only the "IDP name" input field is visible; "SAML group" is gone.
  - Clicking Continue with a valid IDP name still resolves the origin correctly.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/ui/screens/screen-connect-idp-custom.jsx
  git commit -m "fix(connect): halve cockpit image + remove editable SAML group field"
  ```
