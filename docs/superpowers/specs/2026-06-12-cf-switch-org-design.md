# CF Switch Org/Space Feature — Design Spec

**Date:** 2026-06-12  
**Status:** Approved

---

## Summary

Add a "Switch Org" button to the Cloud Foundry login card on the Login screen. When clicked, the wizard runs a 4-step re-targeting flow (`cf orgs` → pick org → `cf target -o` → `cf spaces` → pick space → `cf target -o -s`) without requiring the user to re-authenticate. The button is visible only when CF login is already complete; it hides itself during the org/space selection sub-flow.

This mirrors the existing "Switch Account" button on the BTP card, using the same approach: reuse the existing `cf:orgChoice` / `cf:spaceChoice` events and picker UI, gate rendering on a new `cfSwitchingOrg` flag.

---

## Approach

Option A (chosen): new one-shot orchestrator handlers + `cfSwitchingOrg` flag in the UI. The flag is a single branch point that routes `selectCfOrg` / `selectCfSpace` to the new switch handlers instead of the login-flow stdin write. The picker JSX is reused as-is; no duplication.

---

## Backend — `packages/core/orchestrator.js`

### New state fields

```js
state.cfSwitchOrgList      = null;  // string[] of org names from `cf orgs`
state.cfSwitchSelectedOrg  = null;  // org name chosen in step 2
state.cfSwitchSpaceList    = null;  // string[] of space names from `cf spaces`
```

### New handlers

#### `cf:switchOrgStart`

1. Runs `cf orgs` via `run()`.
2. Parses output: skip lines matching `/^Getting /i` (the "Getting orgs as…" header), the literal `OK` line (CF CLI v7), the literal `name` line (CF CLI v8 column header), lines starting with `---` (separator), and blank/whitespace-only lines. Each remaining non-empty line is an org name.
3. If no orgs found or exit code non-zero: return `{ ok: false, error }`.
4. Stores list in `state.cfSwitchOrgList`.
5. Emits `cf:orgChoice` with the same shape as the login flow:
   ```js
   { orgs: [ { index: 1, name: "org1", recommended: true/false }, ... ] }
   ```
   `recommended: true` when `o.name === state.org` (current org highlighted).
6. Returns `{ ok: true }`.

#### `cf:switchSelectOrg({ index })`

1. Looks up `state.cfSwitchOrgList[index - 1]`. Returns `{ ok: false, error }` if not found.
2. Runs `cf target -o <orgName>`.
3. If exit code non-zero: return `{ ok: false, error: stderr }`.
4. Stores `state.cfSwitchSelectedOrg = orgName`.
5. Runs `cf spaces`.
6. Parses output using the same skip logic as orgs: skip `/^Getting /i`, `OK`, `name`, `---` prefixes, and blank lines.
7. Stores list in `state.cfSwitchSpaceList`.
8. Emits `cf:spaceChoice`:
   ```js
   { spaces: [ { index: 1, name: "space1" }, ... ] }
   ```
9. Returns `{ ok: true }`.

#### `cf:switchSelectSpace({ index })`

1. Looks up `state.cfSwitchSpaceList[index - 1]`. Returns `{ ok: false }` if not found.
2. Runs `cf target -o <state.cfSwitchSelectedOrg> -s <spaceName>`.
3. If exit code non-zero: return `{ ok: false, error: stderr }`.
4. Updates `state.org = state.cfSwitchSelectedOrg` and `state.space = spaceName`.
5. Clears `state.cfSwitchOrgList`, `state.cfSwitchSelectedOrg`, `state.cfSwitchSpaceList`.
6. Emits `cf:switchOrgDone { org, space }`.
7. Returns `{ ok: true }`.

### New event

| Event | Payload | Emitted by |
|---|---|---|
| `cf:switchOrgDone` | `{ org, space }` | `cf:switchSelectSpace` on success |

---

## IPC surface

Add to **both** `apps/figaf-local/main-process/preload.js` and `apps/figaf-manager/cloud/client.js`:

```js
// preload.js
cf.switchOrgStart:      () => ipcRenderer.invoke("cf:switchOrgStart"),
cf.switchSelectOrg:     (index) => ipcRenderer.invoke("cf:switchSelectOrg", { index }),
cf.switchSelectSpace:   (index) => ipcRenderer.invoke("cf:switchSelectSpace", { index }),

// client.js
cf.switchOrgStart:      function ()      { return rpc("cf:switchOrgStart"); },
cf.switchSelectOrg:     function (index) { return rpc("cf:switchSelectOrg", { index: index }); },
cf.switchSelectSpace:   function (index) { return rpc("cf:switchSelectSpace", { index: index }); },
```

---

## Frontend — `packages/ui/screens/screen-login.jsx`

### New state

```js
const [cfSwitchingOrg, setCfSwitchingOrg] = React.useState(false);
```

### New / modified functions

**`switchCfOrg()`** (new):
```
setCfSwitchingOrg(true)
setOrgChoice(null), setSpaceChoice(null)
result = await api.cf.switchOrgStart()
if result.ok === false:
  appendLog([{ type: "err", text: result.error }])
  setCfSwitchingOrg(false)
```

**`cancelCfSwitch()`** (new):
```
setCfSwitchingOrg(false)
setOrgChoice(null)
setSpaceChoice(null)
```

**`selectCfOrg(index)`** (modified — branch on flag):
```
if cfSwitchingOrg:
  result = await api.cf.switchSelectOrg(index)
  if result.ok === false:
    appendLog([{ type: "err", text: result.error }])
    setCfSwitchingOrg(false)
else:
  existing login-flow behavior (api.cf.selectOrg)
```

**`selectCfSpace(index)`** (modified — branch on flag):
```
if cfSwitchingOrg:
  result = await api.cf.switchSelectSpace(index)
  if result.ok === false:
    appendLog([{ type: "err", text: result.error }])
    setCfSwitchingOrg(false)
else:
  existing login-flow behavior (api.cf.selectSpace)
```

### New event listener (inside `useEffect`)

```js
const offSwitchDone = api.on("cf:switchOrgDone", ({ org, space }) => {
  setCfSwitchingOrg(false);
  setOrgChoice(null);
  setSpaceChoice(null);
  setLogin(l => ({ ...l, org, space }));
});
// cleanup: offSwitchDone && offSwitchDone()
```

### Condition changes

| Block | Old condition | New condition |
|---|---|---|
| Org picker | `!cfLoggedIn && orgChoice?.orgs?.length > 0` | `(!cfLoggedIn \|\| cfSwitchingOrg) && orgChoice?.orgs?.length > 0` |
| Space picker | `!cfLoggedIn && spaceChoice?.spaces?.length > 0` | `(!cfLoggedIn \|\| cfSwitchingOrg) && spaceChoice?.spaces?.length > 0` |
| Passcode section | `btpLoggedIn && !cfLoggedIn` | `btpLoggedIn && !cfLoggedIn && !cfSwitchingOrg` |

### New "Switch Org" button

In the CF card header row, alongside the existing "Sign out" button:

```jsx
{cfLoggedIn && !cfSwitchingOrg && (
  <button
    className="btn btn-ghost"
    style={{ fontSize: 12, padding: "4px 10px" }}
    onClick={switchCfOrg}
  >
    <Ico.Refresh /> Switch Org
  </button>
)}
```

### Cancel button in pickers (switch flow only)

At the bottom of both the org picker section and the space picker section, render a cancel row when `cfSwitchingOrg` is true:

```jsx
{cfSwitchingOrg && (
  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
    <button
      className="btn btn-ghost"
      style={{ fontSize: 12, padding: "4px 10px" }}
      onClick={cancelCfSwitch}
    >
      Cancel
    </button>
  </div>
)}
```

---

## Error handling

- `cf:switchOrgStart` failure (e.g. CF not targeted, network): append to terminal log, reset `cfSwitchingOrg`.
- `cf:switchSelectOrg` failure (e.g. `cf target -o` error): append to log, reset `cfSwitchingOrg`. User sees the "Switch Org" button again.
- `cf:switchSelectSpace` failure: same — append to log, reset flag. Previous org/space in `login` state are unchanged.
- No partial state is ever committed to `state.org` / `state.space` until `cf target -o -s` succeeds.

---

## Files changed

| File | Change |
|---|---|
| `packages/core/orchestrator.js` | New state fields; 3 new handlers; new `cf:switchOrgDone` event |
| `apps/figaf-local/main-process/preload.js` | Expose 3 new `cf.*` methods |
| `apps/figaf-manager/cloud/client.js` | Expose 3 new `cf.*` methods |
| `packages/ui/screens/screen-login.jsx` | `cfSwitchingOrg` state, 3 new/modified functions, new event listener, button, cancel buttons, condition changes |

No new files. No other screens affected.
