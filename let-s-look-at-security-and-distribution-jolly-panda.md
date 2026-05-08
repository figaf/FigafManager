# Distribution Strategy — Re-evaluated against new constraints

## Context

The original [SECURITY_AND_DISTRIBUTION_ANALYSIS.md](SECURITY_AND_DISTRIBUTION_ANALYSIS.md) was drafted before three hard constraints were known, and on top of that contained a wrong premise about what BTP gives you out of the box.

### Three hard constraints

1. **EV code-signing cert is out of budget** (~$300–500/yr), which kills Path 4 as a primary route.
2. **SAP API Policy** restricts customer/third-party use to *Published APIs* and prohibits "scraping, harvesting, or systematic/large-scale data extraction" — and adds an unusual restriction on AI-driven systems that "plan, select, or execute sequences of API calls" outside endorsed architectures. The safe pathway here is anything that goes through SAP's own published CLIs (`btp`, `cf`) — which by definition use Published APIs the way SAP intends.
3. **Minimum BTP-side setup**: replacing the CLIs with direct REST calls would force the user to create a Cloud Management Service instance + service key in their subaccount. That is exactly the friction the installer exists to remove.

Reading [bridge.js](main-process/bridge.js) confirms the architectural fact that makes the decision: **every operation is CLI orchestration**. No raw REST. Once you accept that the CLI is the trust anchor, the question collapses to: *where do we run that CLI?*

### Premise correction: there is no "BTP Cloud Shell"

The original analysis (and an earlier version of this doc) leaned on "BTP Cloud Shell" as a pre-authenticated Linux container inside customer subaccounts. **That was wrong.** The `btp` CLI is a *local-machine* tool — you install it on your own OS and it talks to BTP backends from there. It is not, and was never, a shell hosted on BTP. There is no remote interactive shell that ships pre-authenticated with subaccounts.

The closest substrate to what we wanted is **SAP Business Application Studio (BAS)** — a web-based IDE with an integrated terminal. But BAS:

- Requires the customer to subscribe to it as a separate BTP service (admin friction, possible licensing cost).
- Is not pre-installed; the customer must explicitly enable it in their subaccount.
- Has its own quota and lifecycle that we don't control.

BAS could host the wizard if a customer already has BAS, but it is not a default trust pathway for a generic prospect. It is at best a tertiary option.

This invalidates the previous draft's "Phase 1 — Cloud Shell wizard" plan. The Cloud Shell path was attractive because of the pre-auth property; without it, plain `cf push` of an admin app strictly dominates.

---

## Recommendation: Path 1 (BTP-Hosted Figaf Manager app) as the primary direction

Deploy the installer itself as a `cf push`'d app inside the customer's own BTP subaccount, branded **Figaf Manager** to signal long-term intent (install today, manage/update tomorrow). The wizard runs as a Cloud Foundry app at `https://figaf-manager.<cfdomain>`. Same React UI as today, served from inside the customer's own BTP boundary. The app is ephemeral by default — the customer deletes it after the deploy completes (or keeps it around as a manage/update console as that feature lands).

### Why this is the right shape

**Architectural fit with the product.** The Figaf product itself ships as a CF app via this exact mechanism (see [Figaf-BTP-Deployment-btp-users/manifest.yml](Figaf-BTP-Deployment-btp-users/manifest.yml)). Co-locating the manager/admin surface with the product means:

- Single deployment topology for prospects to learn.
- A natural home for the manage/update roadmap features ([CLAUDE.md](CLAUDE.md) hints: `connectSteps`, the commented `figaf-connectivity` / `figaf-destination` services).
- The "Figaf Manager" name leaves room to grow the same app from one-shot installer into a persistent admin console as that scenario lands — the underlying deployable shape is the same.

**Best-possible trust story.** Nothing crosses the customer's BTP boundary. The manager runs inside their subaccount, executes against their own CF org/space, and Figaf never holds a credential or a token. Strictly stronger than any path that involves Figaf-hosted infrastructure or downloaded binaries on user machines.

### The two real challenges

These are the things that have to be designed before we commit. Implementation detail lives in [plan.md](plan.md); the strategic shape is below.

**Challenge 1 — Running the btp/cf CLIs inside a CF container.** Both CLIs are standalone Linux binaries; they can be vendored into the deployment, marked executable, and spawned as child processes from the Node.js app — same `child_process.spawn` pattern as today. Their config caches (`~/.config/.btp/`, `~/.cf/`) are redirected to a writable path in the container via `SAPCP_CLIENTCONFIG` and `CF_HOME` environment variables. This is exactly what Gemini outlined and what plan.md formalizes.

**Challenge 2 — Bootstrap (chicken-and-egg).** To deploy the manager app via `cf push`, *something* has to run `cf push` once. The pragmatic answer turns out to be **the BTP cockpit's own Deploy Application dialog**: customer downloads `figaf-manager-app-<ver>.zip` from figaf.com, signs into the cockpit they already use, navigates to their CF space → Applications → Deploy Application, and uploads the zip with the bundled `manifest.yml`. Cockpit performs `cf push` server-side. Zero client install — not even Node.js. The trust anchor is SAP's own UI doing what it advertises. (Earlier drafts proposed a `npx @figaf/installer-bootstrap` CLI; the cockpit upload eliminates even that, see [plan.md](plan.md) §2.4.)

**Challenge 3 — Keeping the manager zip small and the deployment template current.** The figaf product's deployment artifacts (`manifest.yml`, `vars.yml`, `xs-security.json`, `db.json`, `approuter/`) live on a public branch — `figaf/Figaf-BTP-Deployment` `btp-users`. Rather than bundling them into the manager zip and re-cutting a manager release every time those manifests move, the manager fetches them at wizard-deploy time from `https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip`, extracts to `$HOME/deploy/`, and proceeds. Smaller artifact, decoupled iteration, always-current template. See [plan.md](plan.md) §2.5.

### Authentication inside the deployed app — and why no XSUAA

| Approach | UX | Tradeoffs |
|---|---|---|
| **Interactive SSO inside the app, no XSUAA** (preserve current passcode flow) | User pastes passcode just like today, but into the web app instead of the desktop app | Strongest match to current UX; no technical user / service key / role collection needed; user's authority is explicit and visible; matches today's bridge.js login choreography |
| **XSUAA-gated app** | One extra SAP login redirect on first visit | Requires customer to pre-create an XSUAA service instance + assign a role collection before deploy. Re-introduces the "minimum BTP-side setup" friction we rejected. Plus a self-restage problem: binding XSUAA to a running manager mid-wizard kills the container. |
| **Technical user credentials** (Gemini's suggestion) | App authenticates via stored username/password on startup | Friction: customer must create + manage a technical user; password storage is a liability; not aligned with "minimum BTP-side setup" |
| **Cloud Management Service service key** | App binds to a CIS instance, calls REST APIs directly | Same setup friction we rejected for Path 3; abandons CLI orchestration |

**Recommended: interactive SSO inside the app, no XSUAA on the manager itself.** The manager app has no service bindings and no role gate. The route `https://figaf-manager.<cfdomain>` is publicly reachable but **powerless without a fresh SAP SSO passcode** — every state-changing action in the wizard either spawns a `cf` / `btp` child process that requires `cf login --sso` first, or works against state seeded by that login. A drive-by visitor sees the wizard UI and a login screen asking for a passcode they cannot obtain. That passcode page is itself gated by SAP's central SSO (Identity Authentication / IAS) with whatever MFA controls the customer has at the IAS level.

This is the same authority model the Electron build uses today — XSUAA wouldn't add anything beyond what `cf login --sso` already gives us. It also dodges the **self-restage problem**: binding XSUAA to a running app via `cf bind-service` + `cf restage` would kill the container running the wizard mid-flight. Skipping XSUAA avoids that entirely.

The manager is **ephemeral**. The customer deletes it (`cf delete figaf-manager`) after the figaf product is deployed; the wizard's final screen surfaces this as a one-click action. Window of public exposure is the duration of one wizard session, typically <30 minutes.

(For Phase 2 — the persistent admin console — XSUAA goes back in, but ships *bound from the start* in the manifest of a separately-named app. No mid-flight restage, no chicken-and-egg.)

### Sunset — Electron desktop app

Keep the existing Electron build for:

- Air-gapped / offline customers (rare). The Electron build bundles the deployment template directory; the BTP-hosted manager fetches it from GitHub at runtime, so the Electron path is the only one that works without internet egress to `github.com`.
- Internal Figaf use during development.
- A fallback if a customer's corporate policy blocks the cockpit Deploy Application path or upload size limits trip on the zip.

Do not promote it as the primary distribution on figaf.com. Without an EV cert, SmartScreen friction makes it the worst option for new enterprise customers. The cockpit-upload path strictly dominates on every other axis.

---

## Why I am dropping the other paths

- **Path 2 (Cloud Shell wizard)** dies on the premise correction above. Without a pre-authenticated BTP-hosted shell, Cloud Shell loses its main appeal vs. plain `cf push` of an admin app. BAS could play a similar role for customers who already have it, but it is not a default pathway. The previous draft's heavy Cloud Shell focus was based on a wrong assumption.
- **Path 3 (Browser SaaS with OAuth)** dies on two of the new constraints: (a) it requires direct REST calls to BTP/CF, several of which need a CIS service key in the customer's subaccount → violates "minimum BTP setup", and (b) `cf push` over CF v3 REST (uploading droplets, streaming logs) is a multi-week engineering lift for no incremental security benefit over Path 1. Same trust story, ~10× the effort.
- **Path 4 (Signed Electron)** dies on EV-cert budget. Even an OV cert (~$100/yr) leaves SmartScreen friction until reputation is built — meaningless for enterprise customers who do explicit allowlisting.

---

## Trust model & mitigations

Path 1 has a *fundamentally* better trust story than any client-side path:

- **Nothing runs on the customer's local machine.** The customer downloads a signed zip and uploads it via the BTP cockpit they already use; no CLI, no npx, no Node.js.
- **The manager app runs inside the customer's own BTP subaccount**, in their own CF space, under their own org/space user's authority.
- **Figaf never sees a credential or a token.** The user authenticates directly via `cf login --sso` against SAP's own login endpoint; the passcode never leaves their browser session except into the cf child process running inside their own CF container.
- **The wizard is gated by SAP SSO, not XSUAA.** The route is public but inert — no `cf login --sso` passcode means no action against the subaccount. The passcode page is itself behind the customer's IAS with whatever MFA controls they configured.
- **The app is ephemeral.** Customer runs `cf delete figaf-manager` after the deploy completes (one click in the wizard's final screen). Nothing persists between wizard sessions.

### Residual attack surface

A malicious or compromised version of the manager app could in principle:

- Once a user pastes a valid `cf login --sso` passcode, run destructive `cf` / `btp` commands against unrelated apps, services, or role collections in the org/space the user targeted.
- Read environment of other apps in the same space via `cf env <app>` — service-binding credentials are visible.
- Lateral movement if the user happens to be a global account admin (assigning role collections, creating subaccounts).

This is the same blast radius any administrative tool acting under a user's `cf` authority has. It is a much smaller surface than the current Electron build (which has full local FS access, can spawn arbitrary unrelated processes, and persists on the user's machine indefinitely).

A drive-by visitor on `https://figaf-manager.<cfdomain>` who is *not* the customer cannot do anything — the wizard is unusable without a fresh SAP-issued passcode, and SAP's passcode endpoint requires their own IAS authentication. Combined with the short lifetime (deletion after use), the public route is effectively a vestigial listener.

### Concrete mitigations to implement

| Mitigation | Effort | What it buys |
|---|---|---|
| Open-source repo on GitHub (`figaf/figaf-manager`) | Low — pre-publication scrub of `git log -p` for internal references | Auditability. IT can read every line before deploying. |
| Sigstore/cosign signature on every tagged release zip | Medium — GitHub Actions release workflow, ~½ day | Free signing without per-year cert costs. IT verifies `figaf-manager-app-<ver>.zip` against the published `.sig`/`.cert` before uploading to the cockpit. Keyless OIDC — no signing key to manage. |
| Versioned, immutable zip URL on figaf.com | Low — release publish step | The download URL itself is the pin (`/manager/v1.0.0/figaf-manager-app.zip`). No "latest" autoloader to hijack. |
| One-page command-surface document inside the zip's README | Low — generate from `lib/cli-orchestrator.js` handlers | IT preapproves the exact list of `cf`/`btp` commands the manager issues, plus the GitHub URL the manager fetches the deployment template from. Bundled with the zip so it travels with the artifact. |
| `--dry-run` flag in manager app | Medium — wrap `run()` so each invocation prints-and-skips | Customer runs the wizard end-to-end without side-effects to inspect every command. Builds confidence on first contact. |
| Least-privilege guidance in README | Low | Recommend a CF Space Developer + Subaccount User Administrator + the role collection that allows assigning role collections, not a global admin. Limits blast radius. |
| Cookie-based per-session isolation, signed with per-app-instance secret | Low | Two simultaneous users on the same manager instance get separate `CF_HOME` / `SAPCP_CLIENTCONFIG`. No cross-session leakage without needing XSUAA. |
| Pinnable deployment-template source via `FIGAF_DEPLOYMENT_ZIP_URL` env var | Low | IT teams that want to vet the exact deployment manifest can fork the public repo (or mirror to S3) and point the manager at their fork. Default is `figaf/Figaf-BTP-Deployment` `btp-users` tip. |
| One-click "Delete this manager app" at end of wizard | Low — adds `cf:deleteApp` handler + button | Limits the public-route exposure window to ~one wizard session. No long-running drive-by surface. |

### Comparison with the current Electron .exe

| Risk vector | Electron (today) | BTP-hosted manager (proposed) |
|---|---|---|
| Code unreadable (binary) | Yes — .exe + .asar | No — plain JS / JSX, open-sourced |
| Persists on user's machine | Yes — installer + userData dir | No — only a downloaded zip, deleted after upload |
| Persists in customer's subaccount | N/A | Only for the duration of one wizard session — `cf delete figaf-manager` is the final step |
| Filesystem access outside the project | Yes — full FS access via Node | No — sandboxed to CF container in customer's own subaccount |
| Can spawn arbitrary processes | Yes — `spawn` is unconstrained | Same surface, but inside customer-owned CF container, only after a fresh `cf login --sso` |
| Auditable before running | No (without reverse engineering) | Yes — IT inspects the zip's contents and verifies the cosign signature before uploading |
| Distribution-hijack risk | figaf.com binary swap (no signing) | figaf.com zip swap, mitigated by versioned URL + cosign signature; no transitive npm graph |
| Deployment-template tampering | N/A (bundled snapshot) | Public GitHub URL fetched at runtime; `FIGAF_DEPLOYMENT_ZIP_URL` lets IT pin to a fork or mirror |
| Credential exposure to Figaf | Possible (any locally-installed app could exfiltrate) | Architecturally impossible — Figaf is not in the path |

**Conclusion:** Path 1 has strictly less surface than the current Electron build on every axis, and shifts the trust unit from a binary into a deployable app the customer fully controls.

---

## Marketing angle

**"Deploy Figaf without leaving your BTP cockpit."**

- Download a signed zip. Upload it via the cockpit's own Deploy Application dialog. **Figaf Manager** runs *inside* your subaccount, sitting next to the Figaf product it deploys.
- Zero client install — no Node.js, no CLI, no scripts. Just the cockpit your team already uses.
- **No prerequisite setup.** No XSUAA service instance, no role collection, no service marketplace step. Click Deploy, log in, deploy Figaf, optionally delete the manager.
- Authenticates with your own SAP SSO credentials. Figaf never holds a token.
- Open-source, cosign-signed releases, downloaded from a versioned URL. Deployment template fetched live from a public GitHub repo at deploy time — pin or mirror it via env var if your IT team wants to vet the exact manifest.
- No signing certificates to chase, no SmartScreen warnings, no IT-allowlist applications.

This frames Figaf as *more* trustworthy than traditional SaaS installers, not less.

---

## Implementation

The detailed implementation plan — host-agnostic refactor, CF-hosted server adapter, bootstrap CLI, manifests, verification — is in [plan.md](plan.md).
