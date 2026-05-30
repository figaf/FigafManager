# Update Figaf Tool — Implementation Plan (figaf-manager)

A new wizard branch that detects an already-deployed Figaf Tool in the
operator's current CF org/space, refreshes the deploy templates from GitHub,
applies XSUAA changes, and rolls the two CF apps (`<ID>-app`, `<ID>-router`)
forward to the latest Docker image — without downtime, without losing
operator-applied drift, and resumable if the dyno is recycled mid-flow.

This is hosted-mode only (figaf-manager). figaf-local does not need an
"update" flow yet — Windows operators just re-run the installer.

---

## Architectural Decisions (opinionated, not menus)

### D1. Detection: probe by configured ID, with auto-discovery fallback offered as a confirmation, not as a default

**Pick:** Read `ctx.deployId` from a fresh `config:detectDeployment` handler that
runs three probes in order:

1. **Explicit input first.** Default to `figaf-tool` (the manifest default) but
   let the operator edit the ID on the first screen of the Update flow. This is
   the same affordance vars.yml exposes during install.
2. **Probe `<ID>-app` + `<ID>-router` apps via `cf app <name>`** (exit 0 = exists,
   exit 1 + `App '<name>' not found` = absent). Cheaper than `cf curl` and uses
   the same idiom as `xsuaa:upgradeStatus`.
3. **If neither exists, run `cf curl /v3/apps?names=...&space_guids=<current>`**
   and look for apps whose names match the regex `^.+-(app|router)$` AND whose
   docker image starts with `figaf/app:`. Present results as a numbered list:
   "Found 2 candidate deployments — which one do you want to update?"

**Why not pure auto-discover:** Two reasons.
- The operator may have multiple Figaf Tool instances in the same space
  (test/prod-like). Auto-picking one is a footgun.
- Detection by docker-image-name on `<ID>-app` is robust because the image is
  pinned in the manifest, but the `<ID>-router` is a buildpack app and only
  identifiable by name pattern + service bindings. Better to anchor on the
  operator-known ID.

**Why not pure operator input:** New operators inheriting a deployment may not
know the ID. The `cf curl` fallback is a one-line ergonomic save.

### D2. Rolling push, not stop+delete

**Pick:** `cf push <name> --strategy rolling --vars-file vars.yml` against the
existing `<ID>-app` and `<ID>-router`. Already settled in agent memory
([[feedback-rolling-push-over-delete]]) and re-confirmed here:

- **No downtime.** Rolling push keeps the old instance serving traffic until
  the new one's health check passes.
- **Drift preservation.** `cf push` over an existing app preserves extra routes,
  set-env overrides, instance counts, and network policies that aren't in the
  manifest. Stop+delete wipes them silently.
- **Image tag refresh works.** `figaf/app:((DOCKER_IMAGE_VERSION))` re-resolves
  after `vars.yml` is rewritten — delete is not needed to pick up a new tag.
- **Fail-closed semantics.** A bad image → CF rejects the rolling deploy, old
  instance keeps serving. Stop+delete with a bad image leaves nothing running.
- **Service bindings stay live** for `figaf-db` and `figaf-xsuaa` — no unbind
  race window.

**When stop+delete is still right:** manifest *shape* changes (app rename,
route rename, process-type change). Surface those behind a separate
"Recreate (with downtime)" v2 affordance — out of scope for MVP.

### D3. Deploy-templates cache: force-refresh via `resolveDeployDir({ force: true })`

**Pick:** Add an optional `{ force }` arg to `resolveDeployDir()`. When true,
delete `state.deployDirResolved` and the extracted directory on disk, then
re-download. The Update flow always calls with `{ force: true }` on entry.

**Why not a separate `update/` subdir:** That doubles disk usage on the dyno
and creates two divergent template sources. Manager dynos are small.

**Why not invalidate on a TTL:** Operators expect "I clicked Update, it pulled
the latest" — a TTL adds a "why didn't it pull?" failure mode. Force on entry
to the flow is unambiguous.

**Why not just `rm -rf` from the new handler:** Centralizing the cache logic
in `resolveDeployDir` keeps a single source of truth for the cache path. The
install flow's first-use path is unchanged.

### D4. XSUAA update before app push

**Pick:** Order is (1) `cf update-service figaf-xsuaa -c xs-security.json`
→ (2) rolling push `<ID>-app` → (3) rolling push `<ID>-router`.

**Why XSUAA first:** New role-collection definitions or scope additions in the
refreshed `xs-security.json` must be live in XSUAA before the new
`<ID>-app` boots and validates its JWT scopes. Doing it after a rolling push
creates a window where the new instance is up but rejecting requests on scopes
that don't yet exist server-side.

**Why router last:** approuter routes use the app's destinations; the app must
be healthy before fronting traffic to it. Rolling push gates on health, so
this is belt-and-suspenders.

**Skip XSUAA update when unchanged:** Diff the refreshed `xs-security.json`
against the currently-deployed one (read via `cf curl
/v2/service_instances/<guid>` → `last_operation` is not enough; we need
parameters from the XSUAA broker — see D8 below). If byte-identical after
normalization (sorted keys, stripped comments), skip the update-service call
entirely. This avoids needless 30–60s polling on a no-op.

### D5. Idempotency & resumability via persisted flow state

**Pick:** Write a `update-state.json` file under
`$HOME/sessions/<sid>/figaf-tool-update/` after each completed phase, of
shape:

```json
{
  "deployId": "figaf-tool",
  "phase": "xsuaa-updated" | "app-pushed" | "router-pushed" | "verified",
  "startedAt": "...",
  "completedAt": "...",
  "lastError": null
}
```

A new handler `update:resumeStatus()` reads this on flow entry. If present and
incomplete, the UI offers "Resume update of `<deployId>`?" before kicking the
fresh-detection path. Each phase handler checks the file and skips if its
phase is already marked done.

**Why not stateless re-derivation:** Possible (re-detect deployed image tag
vs. desired tag), but:
- Less specific. Mid-`update-service` polling has no observable post-state
  difference from "never started."
- More CF calls per resume.

Persisted state is cheap, easy to GC (the session dir is wiped on dyno
restart anyway, which is the right scope: a fresh dyno = fresh start).

### D6. Reading currently-deployed image tag: `cf curl /v3/apps/<guid>/droplets/current`

**Pick:** Use the v3 droplets endpoint. Returns
`{ image: "figaf/app:2024.12-btp", ... }` for Docker apps. Reliable, doesn't
require parsing `cf app` text output, doesn't depend on `cf env` (which leaks
secrets and is verbose).

We use this for (a) displaying current → target in the Update screen,
(b) skip-if-unchanged optimization (if current == selected target tag and
xs-security.json unchanged, the flow degenerates to a no-op with a clear
"already up to date" Done screen).

### D7. Tag selection UX

**Pick:** Reuse `config:dockerHubBtpTags` (existing handler) to populate a
dropdown of available `*-btp` tags. Default to the newest. Display the
currently-deployed tag inline with a "current" badge. Selecting the same tag
is allowed (operator may want to re-apply role drift fixes without changing
the image).

### D8. Reading deployed xs-security.json

**Pick:** Don't. The XSUAA broker doesn't return the original parameters via
any CF v3 endpoint we control. Instead, store the last-applied
`xs-security.json` hash in `update-state.json` after a successful
update-service. On the next run, hash the refreshed template; if equal to
the stored hash, skip update-service. First-run-after-deployment has no
stored hash, so it always updates (safe default — `update-service` with the
same params is a no-op on the XSUAA broker side, just slower).

---

## Phase-by-phase plan

### Phase 0 — Preconditions & detection

**New handlers** (in `packages/core/orchestrator.js`):

- `update:resumeStatus()` → `{ ok, hasInFlight, state? }`. Reads
  `update-state.json`. Hosted-only.
- `update:detectDeployment({ deployId? })` → `{ ok, found, deployId, app: { name, image, instances }, router: { name }, candidates? }`.
  - With `deployId` arg: probes `<deployId>-app` + `<deployId>-router` via
    `cf app`. On found, calls `cf curl /v3/apps/<guid>/droplets/current` for
    the image tag.
  - Without `deployId`: runs the discovery `cf curl` query (D1 step 3),
    returns `candidates: [{ id, app, router, image }, ...]`.
- `update:begin({ deployId, targetImageTag })` → `{ ok }`. Writes
  `update-state.json` with `phase: "starting"`. Force-refreshes deploy dir.
  Rewrites `vars.yml` with the chosen `deployId` and `targetImageTag` (reuses
  existing `config:writeVars` logic but called from inside this handler so
  we can persist within the same phase boundary).

**Modified handler:**

- `resolveDeployDir({ force } = {})` — when `force === true`:
  1. `delete state.deployDirResolved`
  2. `fs.rmSync(extracted, { recursive: true, force: true })` (only when
     `tmpl.kind === "github"` — the bundle case is no-op).
  Then fall through to existing download-and-extract logic.

**New channel emission:**

- `update:phase` payloads: `{ phase: "<id>", state: "running"|"done"|"failed", error?, detail? }`.
  Mirrors the proven `xsuaa:upgradePhase` pattern.

### Phase 1 — Refresh templates + edit vars

**Handler signature:**

- `update:writeVars({ deployId, dockerTag, vars? })` → `{ ok, path }`.
  Internally calls the same vars-rewrite that install uses, but:
  - Sets `app_name: <deployId>` and the docker-version key from `dockerTag`.
  - Preserves whatever subset of vars the operator passes through (so the
    Update screen can choose to expose just the tag, or the full vars form).
  - Persists the chosen `deployId` and `dockerTag` into `update-state.json`.

**UI:**

- `ScreenUpdateConfig` — minimal form: target tag dropdown, optional
  "advanced (edit vars)" disclosure. Pre-fills from current deployment.

### Phase 2 — Update figaf-xsuaa service (skip if unchanged)

**New handler:**

- `update:updateXsuaa({ deployId })` → `{ ok, skipped, status }`.
  - Computes SHA-256 of refreshed `xs-security.json`. Compares to
    `xs-security-hash` in `update-state.json` (if present).
  - If equal: emit `update:phase {phase:"update-xsuaa", state:"done", detail:"unchanged"}`
    and return `{ ok: true, skipped: true }`.
  - Otherwise: `cf update-service figaf-xsuaa -c <deployDir>/xs-security.json`,
    poll `cf service figaf-xsuaa` for `status: update succeeded|update failed`
    (5s interval, 10min timeout — same shape as `cf:createXsuaa` poll loop).
  - Emit `cf:serviceStatus` so the existing TerminalDrawer + status line
    light up.
  - On success: write `xs-security-hash` into `update-state.json`, mark phase done.

**Why a new handler vs. extending an existing one:** `cf:createXsuaa` is
wedded to the wizard's own `figaf-manager-xsuaa` service name. Keeping a
distinct handler keeps install and update independently evolvable
(per [[feedback-rolling-push-over-delete]] §how-to-apply).

### Phase 3 — Take down old apps

**There is no Phase 3.** Per D2, we do not stop+delete. The phase number is
intentionally left empty in the channel stream so the UI can render a clear
"skipped — rolling deploy keeps service live" line if helpful.

### Phase 4 — Rolling push of app, then router

**New handler:**

- `update:pushApp({ deployId, role })` where `role` is `"app"` or `"router"`.
  Returns `{ ok, name, strategy: "rolling" }`.
  - Resolves deploy dir (already forced-refreshed in Phase 0).
  - Spawns `cf push <deployId>-<role> --strategy rolling --vars-file vars.yml -f manifest.yml`
    from `deployDir`.
  - Streams stdout/stderr via existing `log("cf", ...)` fan-out.
  - On non-zero exit: emit `update:phase {state:"failed"}`, write
    `lastError` to `update-state.json`, return `{ ok: false, error }`. The
    flow is resumable from this phase on the next session.
  - On success: write `phase: "app-pushed"` (or `"router-pushed"`).

**Order:** app first, then router. Sequential, not parallel — the rolling
deploy of router depends on the app being healthy (router's destinations
target the app).

### Phase 5 — Verify + finish

**New handler:**

- `update:verify({ deployId })` → `{ ok, appImage, routerHealth, route }`.
  - `cf curl /v3/apps/<deployId>-app/droplets/current` — confirm new image tag.
  - `cf app <deployId>-router` — confirm `running` state and read the public route.
  - HTTP GET on the route (timeout 10s, accept 200/302) to confirm the public
    surface is alive.
  - On success: mark `phase: "verified"` and `completedAt` in
    `update-state.json`. UI shows ScreenDone with the route, new tag, and a
    "Delete update state" affordance (which the orchestrator's existing
    `cleanup` patterns already handle via session GC, but an explicit button
    is operator-friendly).

---

## File-by-file change list

| File | Change |
|------|--------|
| `packages/core/orchestrator.js` | Add `update:resumeStatus`, `update:detectDeployment`, `update:begin`, `update:writeVars`, `update:updateXsuaa`, `update:pushApp`, `update:verify` to the `handlers` map. Add helpers: `readUpdateState()`, `writeUpdateState(patch)`, `sha256OfFile(p)`. Modify `resolveDeployDir()` to accept `{ force }`. Emit new `update:phase` channel. |
| `apps/figaf-manager/cloud/server.js` | No structural change — RPC dispatch already iterates `sess.handlers[channel]`. Verify WebSocket allow-list (if any) includes `update:phase`. |
| `apps/figaf-manager/cloud/client.js` | Add `update.resumeStatus`, `update.detectDeployment`, `update.begin`, `update.writeVars`, `update.updateXsuaa`, `update.pushApp`, `update.verify` to the `window.figaf` shim, mirroring existing `xsuaa.*` pattern. |
| `apps/figaf-local/main-process/preload.js` | Mirror the same surface, but each method returns `{ ok: false, error: "Update is only available in hosted mode" }` (or omit entirely — orchestrator already gates on `host.isHosted`). Simpler: define them and let the orchestrator gate. |
| `apps/figaf-local/main-process/ipc-bridge.js` | No change — iterates `Object.entries(handlers)` and picks up the new ones automatically. |
| `packages/ui/mode.js` | Add `features.updateFigafTool: window.figafModeFlags.isHosted` so ScreenChoice gates the option. |
| `packages/ui/app.jsx` | Add `updateSteps = [welcome, login, choice, updateConfig, updateProgress, done]` to the step machine; add `case "updateConfig": …`, `case "updateProgress": …`. Branch on `ctx.choice === "update"`. Persist `ctx.update = { deployId, currentImage, targetImage, candidates, resumeState }`. |
| `packages/ui/screens/screen-choice.jsx` | Add a new tile "Update Figaf Tool" rendered when `figafModeFlags.features.updateFigafTool`. Click → `setCtx({ choice: "update" })` → first calls `update.resumeStatus`; if `hasInFlight`, prompts resume. |
| `packages/ui/screens/screen-update.jsx` *(NEW)* | Two sub-screens via internal `phase` state: `ScreenUpdateConfig` (id field + detect + target tag dropdown + advanced vars), `ScreenUpdateProgress` (subscribes to `update:phase` + `cli:line`, renders the 4-step rail: refresh-templates / update-xsuaa / push-app / push-router / verify). Assign `window.ScreenUpdate = ScreenUpdate;` at the bottom — no exports. |
| `apps/figaf-manager/cloud/index.html` | Add `<script src="/installer/screens/screen-update.jsx" type="text/babel">`. |
| `packages/ui/index.html` | Same `<script>` tag for parity — even though Update is hosted-gated, keeping the include avoids divergence; the feature flag suppresses rendering. |
| `packages/ui/screens/screen-done.jsx` | Add a render branch for `ctx.choice === "update"`: shows current vs. previous image tag, route URL, "Delete update state" button (calls a new `update:clear()` or just relies on session GC). |
| `apps/figaf-manager/scripts/build-zip.js` | No change — already stages `packages/ui` recursively, picks up `screen-update.jsx` automatically. |
| `apps/figaf-manager/host.cloud.js` | No change — `resolveDeployTemplate()` already returns the GitHub URL we want; `resolveDeployDir({force})` is in the orchestrator, not the host. |

**Files NOT changed (verify in PR review):** `apps/figaf-manager/manifest.yml`,
`apps/figaf-manager/Dockerfile`, `packages/deploy-templates/*` (the templates
themselves are the input to the update, not modified by it).

---

## UI screens — shapes

### ScreenChoice (modified)

New tile, gated:
```jsx
{window.figafModeFlags.features.updateFigafTool && (
  <ChoiceTile
    id="update"
    title="Update Figaf Tool"
    subtitle="Refresh an existing deployment to the latest image"
    onClick={() => onChoose("update")}
  />
)}
```

### ScreenUpdateConfig (new)

Props: `{ ctx, setCtx, onNext, onBack }`.

State slots:
- `deployId` (default `"figaf-tool"`, editable).
- `detection` (`null | "loading" | { found, currentImage, candidates } | { error }`).
- `targetTag` (populated from `config:dockerHubBtpTags`).
- `availableTags` (loaded once on mount).

Layout:
1. **Deployment ID** input + "Detect" button. On detect, calls
   `update.detectDeployment({ deployId })`. On `found:false` and
   `candidates.length > 0`, renders a candidate picker.
2. **Current image** (read-only badge from detection result).
3. **Target image** dropdown (sorted desc, current tag shown with
   "(current)" suffix).
4. **Advanced** disclosure (collapsed): full vars editor for power users.
5. **Start update** button → calls `update.begin(...)` then sets
   `ctx.step = "updateProgress"`.

On mount, also call `update.resumeStatus`; if `hasInFlight`, render a banner
"Found incomplete update of `<deployId>` (phase: `<phase>`). [Resume]
[Discard & start over]".

### ScreenUpdateProgress (new)

Props: `{ ctx, setCtx, onNext }`.

State:
- `phases` — array of `{ id, label, state }` rendered as a vertical step rail:
  refresh-templates / update-xsuaa / push-app / push-router / verify.
- `currentLine` — last `cli:line` text for the status line.
- `error` — populated on `update:phase {state:"failed"}`.

Subscriptions on mount:
- `window.figaf.on("update:phase", ({phase, state, error}) => …)` — updates
  the rail.
- `window.figaf.on("cli:line", ({source, text}) => setCurrentLine(text))` —
  feeds TerminalDrawer (which is already a sibling).
- `window.figaf.on("cf:serviceStatus", ...)` — for the xsuaa update poll.

Flow control: a single async function `runFlow()` that:
1. `await window.figaf.update.writeVars({...})`
2. `await window.figaf.update.updateXsuaa({deployId})`
3. `await window.figaf.update.pushApp({deployId, role: "app"})`
4. `await window.figaf.update.pushApp({deployId, role: "router"})`
5. `const verify = await window.figaf.update.verify({deployId})`
6. `setCtx(c => ({...c, update: {...c.update, verify}})); onNext();`

On any non-ok result: render an inline error card with "Retry from this
step" (re-calls the same handler — orchestrator-side idempotency makes this
safe) and "Abort" (clears in-flight state via `update:clear`).

### ScreenDone (modified)

`ctx.choice === "update"` branch:
- Title: "Update complete"
- Detail: "Figaf Tool now runs `<targetImage>` (was `<previousImage>`)."
- Primary link: the public route from `update.verify`.
- Secondary: "Open another wizard session" → resets ctx, returns to Choice.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Dyno killed mid-`cf push --strategy rolling`** | Rolling push is server-side from CF's perspective — the push command on the dyno just initiates and polls. If the dyno dies, CF continues the rolling deploy. On resume, `update.detectDeployment` reads the new image tag; if it matches target, mark `phase: app-pushed` and proceed. |
| **Operator runs `cf push` manually in another shell during the flow** | Detect at verify time: if `cf curl /v3/apps/<app>/droplets/current` returns an image tag that's neither the previous nor the target, fail with a clear "deployment changed outside this flow — please re-detect" message. |
| **GitHub fetch fails (rate limit, network)** | `httpsDownload` already has retry-friendly error surfaces. Wrap the force-refresh in a try/catch that, on failure, falls back to the cached `state.deployDirResolved` if it exists *and* the operator confirms via a "Use cached template?" prompt. Default is fail-fast. |
| **Image tag mismatch after push** (CF accepted a different tag than requested) | Verify phase explicitly compares `appImage` to `targetImageTag`. Mismatch → mark verify failed, surface both values, offer retry. |
| **xs-security.json role-collection drift** (operator hand-edited via cockpit) | `update-service` with our refreshed params is an authoritative overwrite — this is the desired semantic for an "update" flow. Document this loudly in ScreenUpdateConfig: "This will reset role-collection assignments to the template defaults." Provide a checkbox "Skip XSUAA update" for paranoid operators (sets a skip flag honored by `update:updateXsuaa`). |
| **Two operators kick off Update simultaneously in different sessions** | Each session has its own `update-state.json` under its sessionId. CF-level operations are serialized by CF (CC enforces concurrent-deploy locks per app). Worst case: the second op sees a rolling deploy in progress and CF returns a "deployment in progress" error — we surface it as "another deploy is already running, please wait" and let the operator retry. |
| **Manifest shape drift** (new template introduces a renamed app) | Detection compares the operator-confirmed `deployId` to the manifest's `app_name` template variable. If they mismatch after writeVars, we error out before pushing with "manifest has been restructured — please use the install flow". MVP scope: detect, don't auto-recover. |
| **Service binding lost across rolling push** | CF semantics: bindings persist across rolling push. No mitigation needed beyond a verify-side spot-check (`cf curl /v3/apps/<app>/relationships/service_bindings`) — optional for MVP. |

---

## Pragmatic sequencing — MVP vs. v2

### MVP (one PR, branch `feature/update-figaf-tool`)

In order, each commit independently builds and runs the existing flows:

1. **Orchestrator infrastructure** — `resolveDeployDir({force})`,
   `readUpdateState`/`writeUpdateState` helpers, `update:phase` channel.
   Adds zero new behavior. Smoke: install flow still works.
2. **Detection & resume** — `update:resumeStatus`, `update:detectDeployment`,
   `update:begin`, `update:clear`. Exposed in client.js + preload.js.
3. **Write-vars + XSUAA update** — `update:writeVars`, `update:updateXsuaa`
   (with hash-skip).
4. **Rolling pushes** — `update:pushApp` for `app` and `router`. Verify
   handler.
5. **UI** — mode flag, ScreenChoice tile, ScreenUpdateConfig,
   ScreenUpdateProgress, ScreenDone branch. End-to-end test against a
   throwaway space.

### v2 (deferred, separate PRs)

- **"Recreate (with downtime)" affordance** for manifest-shape changes
  (app rename, route restructure). Behind a second feature flag,
  `features.recreateFigafTool`.
- **Multi-target rolling** (e.g. push app + router in parallel) — only
  if push time becomes a real complaint. Sequential is safer.
- **Update-from-pinned-commit** of the deploy templates GitHub branch
  (currently always `btp-users` HEAD; operators may want to pin).
- **Pre-flight cf API connectivity check** before kicking off, with an
  exponential-backoff health probe of the api endpoint. Currently we just
  fail at the first `cf` call.
- **Auto-snapshot of vars.yml + xs-security.json into update-state.json**
  before applying, for a true "undo" affordance.
- **Notifications** — when a long-running rolling push finishes after the
  operator closed the tab (browser push or email). Out of MVP.

---

## Reference files used (absolute paths)

- `c:\Figaf-installer\packages\core\orchestrator.js`
- `c:\Figaf-installer\apps\figaf-manager\host.cloud.js`
- `c:\Figaf-installer\apps\figaf-manager\cloud\server.js`
- `c:\Figaf-installer\apps\figaf-manager\cloud\client.js`
- `c:\Figaf-installer\apps\figaf-manager\scripts\build-zip.js`
- `c:\Figaf-installer\packages\deploy-templates\manifest.yml`
- `c:\Figaf-installer\packages\deploy-templates\vars.yml`
- `c:\Figaf-installer\packages\deploy-templates\xs-security.json`
- `c:\Figaf-installer\packages\ui\app.jsx`
- `c:\Figaf-installer\packages\ui\mode.js`
- `c:\Figaf-installer\packages\ui\screens\screen-choice.jsx`
- `c:\Figaf-installer\packages\ui\screens\screen-ops.jsx`
- `c:\Figaf-installer\packages\ui\screens\screen-done.jsx`
- `c:\Figaf-installer\.claude\agent-memory\btp-tech-lead\feedback_rolling_push_over_delete.md`
- `c:\Figaf-installer\.claude\agent-memory\btp-tech-lead\project_v2_xsuaa_implementation.md`
