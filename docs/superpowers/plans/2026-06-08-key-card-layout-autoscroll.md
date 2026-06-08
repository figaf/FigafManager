# Key Card Layout Fix + Auto-Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix API/iFlow key card clipping at 100%+ browser zoom and add smooth auto-scroll to all dynamically-revealed UI sections across the wizard.

**Architecture:** Two independent fixes. Fix 1 is a one-line CSS Grid containment change on the `KeyCard` component. Fix 2 adds a reusable `ScrollReveal` component to the shared `components.jsx` primitives file, then wraps every conditionally-rendered section in all affected screens.

**Tech Stack:** React (via Babel standalone, no bundler), plain CSS, vanilla browser APIs (`scrollIntoView`).

---

## File Map

| File | Change |
|---|---|
| `packages/ui/components.jsx` | Add `ScrollReveal` component; add to `window` export |
| `packages/ui/screens/screen-connect-provision.jsx` | `minWidth: 0` on `KeyCard` outer div; wrap key-cards grid in `<ScrollReveal>` |
| `packages/ui/screens/screen-login.jsx` | Wrap 7 dynamic sections in `<ScrollReveal>` |
| `packages/ui/screens/screen-config.jsx` | Wrap cloud connector destination field in `<ScrollReveal>` |

No new files. No changes to `index.html` files — `ScrollReveal` lives in `components.jsx` which is already loaded before all screen files.

---

## Task 1: Add `ScrollReveal` to `packages/ui/components.jsx`

**Files:**
- Modify: `packages/ui/components.jsx` (add component before line 314, update export on line 315)

- [ ] **Step 1: Add the `ScrollReveal` function** immediately before the `Object.assign(window, {` line (currently line 314).

```jsx
function ScrollReveal({ children }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    // 'nearest' scrolls only as far as needed — avoids jarring re-centering
    // when the element is already partially visible.
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);
  return <div ref={ref}>{children}</div>;
}
```

- [ ] **Step 2: Add `ScrollReveal` to the `window` export** (the `Object.assign` call at the bottom of the file).

Replace:
```js
Object.assign(window, {
  Ico, FigafMark, WinFrame, StepperRail, WizardFooter, TerminalDrawer, CheckRow,
});
```

With:
```js
Object.assign(window, {
  Ico, FigafMark, WinFrame, StepperRail, WizardFooter, TerminalDrawer, CheckRow, ScrollReveal,
});
```

- [ ] **Step 3: Verify in the browser**

Open the app in the browser, open DevTools console, and run:

```js
typeof window.ScrollReveal
```

Expected output: `"function"`

- [ ] **Step 4: Commit**

```bash
git add packages/ui/components.jsx
git commit -m "feat(ui): add ScrollReveal shared component"
```

---

## Task 2: Fix key card clipping + wrap key cards in `screen-connect-provision.jsx`

**Files:**
- Modify: `packages/ui/screens/screen-connect-provision.jsx`

Two changes in this file: the `KeyCard` width fix and wrapping the key cards grid.

- [ ] **Step 1: Add `minWidth: 0` to the `KeyCard` outer div**

Find the `KeyCard` function (around line 190). Change the outer div's `style` prop:

Replace:
```jsx
  return (
    <div className="card" style={{ padding: 14 }}>
```

With:
```jsx
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
```

This tells the CSS Grid the item can shrink below its content width. The `<pre>` inside already has `overflow: auto`, so the JSON remains horizontally scrollable.

- [ ] **Step 2: Wrap the key cards grid in `<ScrollReveal>`**

Find the `allDone` conditional block (around line 170):

Replace:
```jsx
            {allDone && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
                <KeyCard label="API key (figaf-api / key-api)" keyData={keys.api} />
                <KeyCard label="iFlow key (figaf-iflow / key-iflow)" keyData={keys.iflow} />
              </div>
            )}
```

With:
```jsx
            {allDone && (
              <ScrollReveal>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
                  <KeyCard label="API key (figaf-api / key-api)" keyData={keys.api} />
                  <KeyCard label="iFlow key (figaf-iflow / key-iflow)" keyData={keys.iflow} />
                </div>
              </ScrollReveal>
            )}
```

- [ ] **Step 3: Verify key card width fix manually**

Open the browser, navigate to Step 4 · Provision (Connect branch). Wait for provisioning to complete so both key cards render.

At browser zoom 100%: both cards should fit side-by-side without the right card being cut off.
At browser zoom 125%: same — cards stay side-by-side, JSON scrolls horizontally within each card.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/screens/screen-connect-provision.jsx
git commit -m "fix(ui): contain key card width in CSS grid; scroll into view on reveal"
```

---

## Task 3: Wrap dynamic sections in `screen-login.jsx`

**Files:**
- Modify: `packages/ui/screens/screen-login.jsx`

Seven sections to wrap. All use the same pattern: the outermost div of the conditionally-rendered block gets a `<ScrollReveal>` parent. Inner content is unchanged in all cases.

- [ ] **Step 1: Wrap the BTP "Choose a global account" section**

Find (around line 282):
```jsx
          {!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
```

Replace the opening with:
```jsx
          {!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
```

And close the `<ScrollReveal>` after the existing closing `</div>` of that section (around line 338):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 2: Wrap the BTP "Choose a subaccount" section**

Find (around line 340):
```jsx
          {!btpLoggedIn && subaccountChoice && subaccountChoice.subaccounts && subaccountChoice.subaccounts.length > 0 && (
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
```

Replace the opening with:
```jsx
          {!btpLoggedIn && subaccountChoice && subaccountChoice.subaccounts && subaccountChoice.subaccounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
```

Close after the section's closing `</div>` (around line 400):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 3: Wrap the BTP connected summary grid**

Find (around line 402):
```jsx
          {btpLoggedIn && (
            <div className="summary-grid slide-in">
```

Replace with:
```jsx
          {btpLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
```

Close after the summary grid's closing `</div>` (around line 411):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 4: Wrap the CF passcode entry section**

Find the ternary inside the CF card (around line 444):
```jsx
              ) : (
                <div className="slide-in">
```

Replace with:
```jsx
              ) : (
                <ScrollReveal>
                <div className="slide-in">
```

Close after the section's closing `</div>` (the one that closes `<div className="slide-in">`, around line 485):
```jsx
                </div>
                </ScrollReveal>
```

- [ ] **Step 5: Wrap the CF "Choose a Cloud Foundry org" section**

Find (around line 489):
```jsx
          {!cfLoggedIn && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
```

Replace the opening with:
```jsx
          {!cfLoggedIn && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
```

Close after the section's closing `</div>` (around line 521):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 6: Wrap the CF "Choose a space" section**

Find (around line 523):
```jsx
          {!cfLoggedIn && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
```

Replace the opening with:
```jsx
          {!cfLoggedIn && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
```

Close after the section's closing `</div>` (around line 550):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 7: Wrap the CF connected summary grid**

Find (around line 552):
```jsx
          {cfLoggedIn && (
            <div className="summary-grid slide-in">
```

Replace with:
```jsx
          {cfLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
```

Close after the summary grid's closing `</div>` (around line 557):
```jsx
            </div>
            </ScrollReveal>
          )}
```

- [ ] **Step 8: Verify auto-scroll on the login screen**

Open the app. On the Sign-in screen, click "Sign in with SSO". When the global account picker appears at the bottom of the BTP card, the pane should smoothly scroll so the picker is visible without manual scrolling.

Repeat verification: after selecting a global account, the subaccount picker should scroll into view. After successful BTP login, the summary grid should scroll into view.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/screens/screen-login.jsx
git commit -m "feat(ui): auto-scroll to dynamic sections on login screen"
```

---

## Task 4: Wrap cloud connector destination field in `screen-config.jsx`

**Files:**
- Modify: `packages/ui/screens/screen-config.jsx`

- [ ] **Step 1: Wrap the cloud connector destination name field**

Find (around line 403):
```jsx
        {cfg.useCloudConnectorForSmtpIntegration && (
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Cloud connector destination name
            </label>
```

Replace the opening with:
```jsx
        {cfg.useCloudConnectorForSmtpIntegration && (
          <ScrollReveal>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Cloud connector destination name
            </label>
```

Close after the field's closing `</div>` (around line 416):
```jsx
          </div>
          </ScrollReveal>
        )}
```

- [ ] **Step 2: Verify auto-scroll on the config screen**

Open the app, navigate to Step 4 · Configuration (Deploy branch). Under "Cloud connector settings", toggle the radio to "Yes". The destination name field should smoothly scroll into view.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/screens/screen-config.jsx
git commit -m "feat(ui): auto-scroll to cloud connector destination field on reveal"
```
