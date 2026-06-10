# BTP Login Rework — `btp target` Hierarchy as the Global-Account Picker

**Date:** 2026-06-10
**Status:** Approved

## Problem

The BTP login flow ([packages/ui/screens/screen-login.jsx](../../../packages/ui/screens/screen-login.jsx) +
[packages/core/orchestrator.js](../../../packages/core/orchestrator.js)) has two defects, both rooted in
selecting the global account (GA) from the **`btp login` interactive prompt**:

1. **Cannot re-pick a GA after sign-out/sign-in.** `btp:loginStart` runs `btp login --sso` and only
   surfaces a GA picker *if* it detects the `Choose a global account:` prompt (orchestrator.js
   `tryDetectGaPrompt`). With `--login.showglobalaccounts false` (the CLI default), `btp login`
   remembers the previous GA and skips that prompt on re-login, so the picker never appears and the
   user is silently stuck on the prior GA.

2. **The GA list is "blind".** The login prompt yields only `{index, displayName}` (orchestrator.js:738).
   There is no subdomain and no subaccount context, so two global accounts that share a display name
   (e.g. two `Figaf ApS` accounts) are indistinguishable — the user picks one at random.

There is **no JSON CLI command** that lists all global accounts a user can reach (confirmed against
[docs/bttp-cli-commands.md](../../bttp-cli-commands.md): `get accounts/global-account` and
`list accounts/subaccount` both require a subdomain or the current target). The only enumeration of
*all reachable* GAs — with their subaccounts — is the interactive tree from `btp login` or `btp target`.

## Verified CLI behaviour

Confirmed live against `btp` client v2.106.1 (the app's bundled binary):

- `btp target --hierarchy true` prints the **full tree** of every reachable GA and its subaccounts, with
  globally-sequential `[N]` indices. GA rows end in `(global account)`; subaccount rows are indented with
  box-drawing chars (`├─` / `└─`) and end in `(subaccount)`.
- `--hierarchy true` works as a **per-invocation flag** — it produces the full tree even when the global
  config `--target.hierarchy` is `false`. (With config off and no flag, `btp target` shows only the
  *current* GA's subaccounts plus a `[..] Switch Global Accounts` entry.)
- The `Current target:` line and the trailing `… stay in 'X' [N]>` prompt expose the **current GA's
  subdomain and its tree index**.
- Spawning `btp target --hierarchy true` and writing `"<index>" + os.EOL` to stdin once the prompt is
  detected **targets that exact node and exits 0** — verified that index `9` vs `6` selects
  `figafaps-03` vs `figafaps-02` (the two same-named `Figaf ApS` accounts). This is the same
  long-lived-proc + stdin mechanism the current `btp login` GA picker already uses.
- Writing the *current* index (or hitting ENTER) leaves the target unchanged and exits 0 — safe for a
  read-only "capture the tree" pass.

## Config strategy

- **`--target.hierarchy`** — never mutate global config. Pass `--hierarchy true` as a **flag** on the
  login-time `btp target` calls only. Deploy-time calls (`btp target --subaccount …` in
  `applySubaccountSelection`) are left at default behaviour. No restore logic anywhere.
- **`--login.showglobalaccounts true`** — set once via `btp set config` at the start of `btp:loginStart`
  (idempotent). It only affects `btp login`, which the orchestrator now auto-handles, so it is left on
  permanently. This makes login deterministically prompt for a GA, which we answer automatically.

## New flow

```
loginStart                          selectGlobalAccount({index})       selectSubaccount({guid})
──────────                          ───────────────────────────        ────────────────────────
set showglobalaccounts=true         btp target --hierarchy true        btp target --subaccount <guid>
btp login --sso                       → write "<index>" to stdin       → btp:loggedIn
  GA prompt?  → auto-write "1"        → parse "Now targeting: …"        (applySubaccountSelection,
  SSO url     → btp:ssoUrl          get accounts/global-account         unchanged)
on exit 0 → listGlobalAccounts()      (subdomain / guid / license)
                │                    listEnvInstances()  ← UNCHANGED (keeps CF probing + rich metadata)
                ▼                          │
   btp target --hierarchy true            ▼
   parse tree; write current idx    >1 CF subaccount → btp:subaccountChoice
   to stay & exit 0                  1 CF subaccount → auto-pick → btp:loggedIn
   1 GA  → auto-select               0 CF subaccount → error (Back to retry)
   >1 GA → btp:gaChoice {tree}
```

Login is now a throwaway "land somewhere" step; the `btp target` tree is the real GA picker, and GA
navigation is **by tree index** (the only thing that disambiguates same-named GAs).

## Orchestrator changes — `packages/core/orchestrator.js`

### `btp:loginStart` (modified)
- Before spawning: `run(btp, ["set", "config", "--login.showglobalaccounts", "true"])` (quiet, idempotent).
- On detecting the `Choose a global account:` prompt, **auto-write `"1" + os.EOL`** to the login proc's
  stdin instead of emitting `btp:gaChoice`. Log a friendly line (e.g. "Signing in…"). The
  `state.btpLoginWaitingForChoice` bookkeeping can be dropped from the surfaced path.
- `btp:ssoUrl` detection unchanged.
- On `close` code 0 → call `listGlobalAccounts()`. On non-zero → emit `btp:loginFailed` (unchanged).
- The GA-info JSON fetch (`get accounts/global-account`) **moves** to `selectGlobalAccount` (it must
  reflect the GA the user actually chose, not the throwaway #1).

### `btp:listGlobalAccounts` (new)
- Spawn `btp target --hierarchy true` (long-lived, prompt-detected — same pattern as `btp login`).
- Parse the tree into `state.gaTree = [{ index, name, subaccounts: [{ index, name }] }]`.
  - GA row regex: `^\s*\[(\d+)\]\s+(.+?)\s+\(global account\)\s*$`
  - Subaccount row regex: `^\s*\[(\d+)\]\s+[├└]─\s+(.+?)\s+\(subaccount\)\s*$` (attach to the most
    recent GA). Strip ANSI/`\r` first, mirroring the existing login parser.
- After parsing, write the **current** index (from the `… [N]>` prompt) to exit 0 without changing the
  target. (Fallback: kill the proc if the prompt index can't be parsed.)
- If `gaTree.length === 1` → call `selectGlobalAccount({ index: gaTree[0].index })` (skip the picker).
- Else emit `btp:gaChoice` with `{ accounts: gaTree }`.

### `btp:selectGlobalAccount({ index })` (signature change: was `{ subdomain }`)
- Spawn `btp target --hierarchy true`; on prompt detected, write `String(index) + os.EOL`; require
  exit 0. If `index` is unknown to `state.gaTree`, return an error without touching the target.
- Set `state.globalAccountName` from `state.gaTree.find(g => g.index === index).name` (authoritative —
  avoids scraping the `Now targeting:` line).
- Run `btp --format json get accounts/global-account` (current target = the chosen GA) → populate
  `state.globalAccountSubdomain` / `globalAccountGuid` / `licenseType` (logic lifted from today's
  `loginStart` close handler; the JSON `subdomain` is authoritative).
- Reset stale subaccount state (`subaccountList`, `subaccountWaitingForChoice`, `provider`).
- Call `listEnvInstances()` (emits `btp:subaccountChoice`, auto-picks a single CF subaccount, or errors).

### `btp:cancelLogin` (modified)
- Kill any live login/target proc, then `btp logout` + `cf logout` (best-effort), and reset the
  GA/subaccount/landscape state (equivalent to the existing `btp:logout` reset).

### `btp:listEnvInstances` (minor)
- Unchanged enumeration and CF probing. The `btp:subaccountChoice` payload gains `globalAccountName` and
  `globalAccountSubdomain` so the UI can show the selected GA at the top of the subaccount step.

### `applySubaccountSelection` / `btp:selectSubaccount` (unchanged)
- Still targets by GUID via `btp target --subaccount <guid>` and emits `btp:loggedIn`.

### `btp:submitChoice` (retained, now internal-only)
- Kept in the handler map for safety, but no longer invoked by the UI (auto-pick writes stdin directly
  inside `loginStart`).

### State additions
- `state.gaTree` (parsed GA→subaccount tree), `state.globalAccountName`.

## IPC surface — both apps

| Surface | Change |
|---|---|
| [apps/figaf-local/main-process/preload.js](../../../apps/figaf-local/main-process/preload.js) | `selectGlobalAccount: (index) => invoke("btp:selectGlobalAccount", { index })`; add `listGlobalAccounts: () => invoke("btp:listGlobalAccounts")` |
| [apps/figaf-manager/cloud/client.js](../../../apps/figaf-manager/cloud/client.js) | `selectGlobalAccount: function (index) { return rpc("btp:selectGlobalAccount", { index }); }`; add `listGlobalAccounts` |

`btp:listGlobalAccounts` is wired automatically in both hosts (ipc-bridge iterates `handlers`; cloud
server looks up `sess.handlers[channel]`).

## UI changes — `packages/ui/screens/screen-login.jsx`

- **GA picker** (`gaChoice`): render each GA card with its **subaccount names listed beneath** (from
  `acct.subaccounts`), disambiguating same-named GAs. Click → `api.btp.selectGlobalAccount(acct.index)`.
  - `selectGa` becomes index-only — remove the `typeof val === "number"` / subdomain branch.
  - Remove the "shared display name" warning banner (subaccounts now disambiguate).
- **Subaccount picker** (`subaccountChoice`): show the **selected GA name** (`globalAccountName`) in a
  header line at the top. Replace the footer "Cancel sign-in" with **"Back"** → calls
  `api.btp.listGlobalAccounts()` and clears `subaccountChoice` to return to the GA picker. Hide "Back"
  when only one GA exists (`gaChoice` had a single entry).
- **"Cancel sign-in"**: shown **only** in the GA picker; calls `cancelBtpLogin` (which now logs out) and
  resets to `idle`.
- **CF login** (passcode / org / space): unchanged.

## Edge cases

- **1 GA** → GA picker skipped (auto-select in `listGlobalAccounts`); "Back" hidden in the subaccount step.
- **1 CF subaccount** → auto-picked (existing behaviour).
- **0 CF subaccounts** → existing error surfaced; "Back" lets the user choose a different GA.
- **`btp login` does not prompt** (single GA, or cached) → no auto-write needed; `close` still triggers
  `listGlobalAccounts`.

## Alternative considered and rejected

**Tree-only subaccounts** — target a subaccount directly by its tree index, skipping `listEnvInstances`.
Faster (no per-subaccount CF probe), but loses CF-enablement disabling, region/provider/subdomain
metadata, and GUIDs. The requirement to "show all the current details" of subaccounts means the rich
`listEnvInstances` picker is retained; the tree is used only for GA-level enumeration and navigation.

## Out of scope

- CF login (passcode/org/space) behaviour.
- The "Connect to Integration Suite" branch.
- Persisting GA/subaccount selections across app restarts.
