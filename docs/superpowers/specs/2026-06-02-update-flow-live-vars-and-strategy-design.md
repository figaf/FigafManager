# Update flow: live-seeded vars + deployment strategy toggle

**Date:** 2026-06-02
**Status:** Design — approved, pending spec review
**Area:** figaf-manager (hosted-only) Update Figaf Tool branch

---

## Problem

The Update flow's `update:writeVars` only forces `id` + `dockerVersion` onto the
freshly-downloaded `vars.yml` template. Every other variable falls back to the
**template defaults**, not the values the live app is actually running with. On a
real update this silently rewrites the deployed configuration.

Observed failure (us10-001 trial space, `figaf-tool`):

```
- memory: 1500M
+ memory: 3700M            # template default INSTANCE_MEMORY clobbered the live 1500M
...
For application 'figaf-tool-app': memory quota_exceeded
FAILED
```

The same diff also flipped `LANDSCAPE_APPS_DOMAIN` (us10-001 → us10) and reset
`LOCATION_ID` / SMTP settings to template blanks — all the same root cause.

A second, separate concern: `cf push --strategy rolling` runs the new instance
**alongside** the old one until the health check passes, consuming ~2× the app's
memory during the overlap. On constrained orgs (trial ≈ 4 GB total quota) this can
trigger `quota_exceeded` or OOM on its own — and compounds the memory-bump bug
above (3700M rolling would need ~7400M).

## Goals

1. The Update form defaults to the **live app's current configuration**, so an
   update never silently changes memory, domain, location, or SMTP settings.
2. Let the operator review and edit those vars before the push (same fields as the
   Deploy config screen, minus docker version).
3. Give the operator control over the push strategy (rolling vs restart) to manage
   the double-memory overlap on tight quotas.

## Non-goals

- The Update flow does **not** provision or modify `figaf-db`. PostgreSQL plan and
  parameter controls from the Deploy config screen are **excluded** from the Update
  form. ("Same vars as deploy" = the `vars.yml` fields only.)
- No automatic org-quota detection / strategy auto-selection (considered, deferred
  as v2 — flaky CF API, more code than the toggle warrants).
- No changes to the phase model, resumability anchor, or the `verify` step beyond
  threading the new inputs.

---

## Design

### 1. New handler — `update:readCurrentConfig({ deployId })`

Hosted-only (returns `{ ok: false, error: "not available in desktop mode" }` in
desktop, like its siblings). Reads the **live** `<deployId>-app` configuration and
returns a `vars` object in the exact shape `config:writeVars` consumes.

App GUID is resolved the same way `update:detectDeployment` already does
(`cf app --guid <deployId>-app`). Then:

| vars.yml field (writeVars key)                          | Source                                                                 |
|---------------------------------------------------------|------------------------------------------------------------------------|
| `instanceMemory`                                        | `cf curl /v3/apps/<guid>/processes/web` → `.memory_in_mb` → `"<n>M"`   |
| `locationId`                                            | env `LOCATION_ID`                                                      |
| `maxRamPercentage`                                      | env `MAX_RAM_PERCENTAGE`                                               |
| `logsTotalSizeCap`                                      | env `LOGS_TOTAL_SIZE_CAP`                                              |
| `enableInstanceMonitoring`                              | env `ENABLE_INSTANCE_MONITORING` (coerce `"true"`/`true` → bool)       |
| `useCloudConnectorForSmtpIntegration`                   | env `USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION` (coerce → bool)         |
| `cloudConnectorDestinationNameForSmtpIntegration`       | env `CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION`            |
| `domain` (LANDSCAPE_APPS_DOMAIN)                        | env `BTP_APP_ROUTER_URL`, strip leading `https://<deployId>.`          |

Env vars come from `cf curl /v3/apps/<guid>/environment_variables` → `.var` map.

Returns:
```js
{ ok: true, vars: { instanceMemory, domain, locationId, maxRamPercentage,
                    logsTotalSizeCap, enableInstanceMonitoring,
                    useCloudConnectorForSmtpIntegration,
                    cloudConnectorDestinationNameForSmtpIntegration },
  partial: <bool> }   // partial=true if any read failed → that field falls back
                      // to the template/empty default and the UI shows a warning
```

If the env-vars or process read fails entirely, return `{ ok: true, vars: {},
partial: true }` — the form still renders with template/blank defaults and warns.

Exposed on `window.figaf.update.readCurrentConfig` in both
`apps/figaf-manager/cloud/client.js` and `apps/figaf-local/main-process/preload.js`
(desktop mirror returns the safe error). Registration is automatic via the
handlers map in both apps.

### 2. ScreenUpdateConfig — real advanced form, live-seeded

The current Advanced disclosure (explanatory text only) is replaced with the
**same field set as the Deploy config screen's General + Application settings +
Cloud connector sections**, minus the Docker version field (the target-tag selector
already above) and minus all PostgreSQL controls.

Fields (bound to `ctx.update.vars`):
- Landscape apps domain
- Location ID
- Instance memory
- Max RAM percentage
- Logs total size cap
- Enable instance monitoring (checkbox)
- Use cloud connector for SMTP (radio) + conditional destination name

Seeding: when Detect succeeds (single app found) or a candidate is picked, call
`update.readCurrentConfig({ deployId })` and merge the returned `vars` into
`ctx.update.vars`. If `partial`, show an inline warning that some live values
couldn't be read and template defaults were used for those.

The advanced section may start collapsed but is **pre-populated** regardless, so a
user who never expands it still pushes with the live config (not template defaults).

### 3. Deployment strategy control

> **Revised 2026-06-02 (see Addendum).** The original `rolling` / `restart` pair
> was replaced with `recreate` / `rolling` after a live trial run proved that even
> a plain in-place `cf push` (the old "restart") trips the trial memory quota,
> because CF stages the new droplet *before* stopping the old app.

A visible card on ScreenUpdateConfig (not hidden in Advanced), with two options:

- **Recreate** (default) — deletes `<deployId>-router` then `<deployId>-app`, then
  pushes the new image fresh. Frees the org's full memory allocation *before* the
  new droplet stages, so it fits within a trial quota. Brief downtime while the app
  restarts. `figaf-db` (and its data) and `figaf-xsuaa` are untouched; bindings and
  routes are recreated from `manifest.yml` on the push. This is Figaf's recommended
  upgrade path.
- **Rolling** — zero downtime; the new instance starts alongside the old one and
  takes over once healthy. Needs ~2× the app's memory free during the overlap *and*
  during staging, so only suitable on orgs with quota headroom.

Stored as `ctx.update.strategy` (`"recreate"` | `"rolling"`).

### 4. `update:deleteApps` (NEW) + `update:pushApp` — strategy param

New handler `update:deleteApps({ deployId, strategy })` runs as a phase between
`update:updateXsuaa` and the pushes:

- `strategy === "rolling"` → no-op (emits a `delete-apps` phase `done` with a
  "skipped (rolling)" detail; the old instances must keep serving).
- otherwise (`recreate`) → `cf delete <deployId>-router -f` then
  `cf delete <deployId>-app -f`. `cf delete -f` exits 0 / prints "does not exist"
  when an app is already gone, so the step is idempotent on retry after a
  half-finished run. Persists `phase: "apps-deleted"`.

`update:pushApp({ deployId, role, strategy })`:

- `strategy === "rolling"` → args include `--strategy rolling`.
- otherwise (`recreate`, or any legacy/unset value) → plain `cf push` (the app was
  already deleted by `update:deleteApps`, so this is a fresh push).

Strategy is persisted to `update-state.json` on `update:begin` so a resumed run
reuses the operator's choice. The delete and both pushes read the same strategy.

### 5. Data flow

```
ScreenUpdateConfig
  detect / pick  ──▶ update:detectDeployment  (existence + image, unchanged)
                 ──▶ update:readCurrentConfig  (NEW) ──▶ ctx.update.vars
  operator edits vars + picks strategy ──▶ ctx.update.{vars, strategy}
  Start update   ──▶ update:begin (persists strategy)

ScreenUpdateProgress.runFlow()
  update:writeVars({ deployId, dockerTag, vars: ctx.update.vars })   // vars already supported
  update:updateXsuaa(...)                                            // unchanged
  update:deleteApps({ deployId, strategy })                          // NEW — recreate only
  update:pushApp({ deployId, role: "app",    strategy })             // strategy NEW
  update:pushApp({ deployId, role: "router", strategy })             // strategy NEW
  update:verify(...)                                                 // unchanged
```

`ctx.update` additions: `vars` (object), `strategy` (string, default `"recreate"`).

---

## Error handling

- `readCurrentConfig` partial/total failure → form falls back to template/blank
  defaults, UI warns; never blocks the flow.
- Boolean env coercion: CF stores env values as strings (`"true"`); coerce
  `"true"`/`true` → `true`, everything else → `false`, matching the existing
  writeVars/manifest expectations.
- Existing retry/resume behaviour is preserved; strategy and vars survive a resume
  because they live in `ctx.update` (in-session) and strategy is persisted in
  `update-state.json` (cross-session).

## Files touched

| File | Change |
|------|--------|
| `packages/core/orchestrator.js` | New `update:readCurrentConfig` + `update:deleteApps` handlers; `update:pushApp` gains `strategy` (rolling adds `--strategy rolling`, else plain push); `update:begin` persists `strategy` (`recreate`/`rolling`). |
| `apps/figaf-manager/cloud/client.js` | Expose `update.readCurrentConfig` + `update.deleteApps`; pass `strategy` through `update.pushApp`/`update.begin`. |
| `apps/figaf-local/main-process/preload.js` | Mirror the surface (desktop returns safe error). |
| `packages/ui/screens/screen-update.jsx` | Replace Advanced placeholder with live-seeded vars form; add strategy card (recreate/rolling); add `delete-apps` phase; seed on detect/pick; thread `vars` + `strategy` through the flow. |
| `packages/ui/app.jsx` | `ctx.update` defaults gain `vars: {}` and `strategy: "recreate"`. |

## Testing

- Unit-style: `readCurrentConfig` mapping (env map + process memory → vars shape),
  including the domain-strip derivation and boolean coercion; partial-failure path.
- Manual against the us10-001 trial space: detect `figaf-tool`, confirm the form
  shows `1500M` / `us10-001` (not `3700M` / `us10`), run a **Recreate**-strategy
  update to the new tag, confirm the `delete-apps` phase removes both apps, the
  pushes succeed with no `quota_exceeded`, and `verify` passes. Confirm the DB data
  survives (the `figaf-db` instance is never touched).
- Regression: a Rolling update on an org with adequate quota still works unchanged
  and the `delete-apps` phase shows "skipped (rolling)".

## Deferred (v2)

- Org-quota auto-detection with automatic strategy fallback.
- Surfacing/editing PostgreSQL config in the Update flow (would require the flow to
  manage `figaf-db`).

---

## Addendum — 2026-06-02: recreate replaces restart

A live Restart-strategy run on the us10-001 trial space still failed:

```
cf push figaf-tool-app --vars-file vars.yml -f manifest.yml
...
organization's memory limit exceeded: staging requires 1500M memory
FAILED
```

**Root cause:** an in-place `cf push` over an existing app *stages the new droplet
before stopping the old one*. So during staging the org momentarily carries
`old app (1500M) + new droplet (1500M)` (+ the router) against the trial quota. The
`restart` toggle only removed the *running* 2× overlap that `--strategy rolling`
causes; it did nothing about the *staging* overlap, which is present for any
in-place push.

**Fix:** the reliable upgrade on a tight quota is to free the memory *before*
staging — delete the apps, then push fresh. This matches Figaf's published upgrade
procedure (`cf delete pi-figaf-router -f` / `cf delete pi-figaf-app -f`, then
`cf push`). The service instances (`figaf-db`, `figaf-xsuaa`) and their data are
untouched; the delete only removes the app and its bindings, which the push
recreates from `manifest.yml`.

So the strategy options became:

- **Recreate** (new default) — delete both apps, push fresh. Peak memory = 1× (the
  staging app only). Works on trial. Brief downtime. Downside: if the push fails
  after the delete, the old app is gone until the retry re-pushes — acceptable and
  exactly what the official procedure does.
- **Rolling** — unchanged; zero downtime, needs ~2× memory headroom.

`restart` was dropped: recreate dominates it on peak memory, and rolling dominates
it on downtime, leaving restart the worst of both. Legacy `strategy:"restart"` in a
persisted `update-state.json` still behaves as a plain in-place push (no delete, no
rolling flag), so no migration is needed.
