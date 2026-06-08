# Key Card Layout Fix + Auto-Scroll Design

**Date:** 2026-06-08
**Status:** Approved

## Problem

Two independent UI issues:

1. **Key card clipping (Step 4 · Provision):** The API key and iFlow key cards sit in a `1fr 1fr` CSS Grid. Grid items default to `min-width: auto`, so a wide `<pre>` (JSON service key text) forces each card beyond its column width, causing overflow/clipping at 100%+ browser zoom.

2. **Hidden dynamic reveals:** When new sections appear in-page (account pickers, passcode entry, login summaries, etc.) they often render below the fold. Users who don't know to scroll miss them entirely.

---

## Fix 1 — Key card width containment

**File:** `packages/ui/screens/screen-connect-provision.jsx`

Add `style={{ minWidth: 0 }}` to the outer `<div className="card">` inside `KeyCard`. This allows the CSS Grid to shrink the item below its intrinsic content size. The `<pre>` already has `overflow: auto`, so the JSON remains horizontally scrollable within the card. No layout changes elsewhere.

**Constraint:** Cards remain side-by-side at all zoom levels. Full JSON readability is secondary to the copy button.

---

## Fix 2 — `ScrollReveal` component

### Component definition

Add to `packages/ui/components.jsx`:

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

- Exported on `window` alongside existing primitives.
- Fires exactly once on mount — the right lifecycle hook for conditionally-rendered sections.
- The wrapper `<div>` carries no styles; existing `slide-in` animations are unaffected.

### Call sites

Wrap the outermost div of each conditionally-rendered section with `<ScrollReveal>`:

| File | Trigger state | Section |
|---|---|---|
| `screen-login.jsx` | `gaChoice` | "Choose a global account" |
| `screen-login.jsx` | `subaccountChoice` | "Choose a subaccount" |
| `screen-login.jsx` | `btpLoggedIn` (summary) | BTP `.summary-grid` |
| `screen-login.jsx` | `passcodeRequested` | Passcode entry |
| `screen-login.jsx` | `orgChoice` | "Choose a CF org" |
| `screen-login.jsx` | `spaceChoice` | "Choose a space" |
| `screen-login.jsx` | `cfLoggedIn` (summary) | CF `.summary-grid` |
| `screen-config.jsx` | `useCloudConnectorForSmtpIntegration` | Cloud connector destination field |
| `screen-connect-provision.jsx` | `allDone` | Key cards grid |

### Usage pattern

```jsx
{someState && (
  <ScrollReveal>
    <div className="slide-in" style={...}>
      {/* dynamic content */}
    </div>
  </ScrollReveal>
)}
```

Any future dynamic section can opt in the same way.

---

## Files changed

| File | Change |
|---|---|
| `packages/ui/components.jsx` | Add `ScrollReveal` component + export on `window` |
| `packages/ui/screens/screen-connect-provision.jsx` | `minWidth: 0` on `KeyCard` outer div; wrap key cards grid in `<ScrollReveal>` |
| `packages/ui/screens/screen-login.jsx` | Wrap 7 dynamic sections in `<ScrollReveal>` |
| `packages/ui/screens/screen-config.jsx` | Wrap cloud connector destination field in `<ScrollReveal>` |
| `packages/ui/index.html` | No change (ScrollReveal is in components.jsx, already loaded) |
| `apps/figaf-manager/cloud/index.html` | No change (same reason) |
