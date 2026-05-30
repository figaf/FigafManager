---
name: feedback-rolling-push-over-delete
description: For Figaf Tool redeploy/update flows, prefer cf push --strategy rolling over stop+delete+push
metadata:
  type: feedback
---

For any flow that re-deploys an already-running figaf-app or figaf-router (e.g. "Update Figaf Tool"), use `cf push --strategy rolling` against the existing apps. Do not stop+delete.

**Why:**
- Stop+delete loses app-level state CF tracks outside the manifest: extra `cf map-route` entries the operator added manually, `cf set-env` overrides, scaled instance counts, network policies. After delete, the next push re-applies only what `manifest.yml` says, silently wiping drift.
- Stop+delete causes a 60–180s 404 window on the public route. Rolling push keeps the old instance serving until the new one passes health checks.
- `cf push` over a Docker app re-resolves the image tag from `figaf/app:((DOCKER_IMAGE_VERSION))` after `vars.yml` is rewritten — no need to delete to pick up a new image.
- Rolling push fails closed: if the new image fails to pull or boot, the old instance keeps serving. Stop+delete fails open: a broken redeploy leaves nothing running.
- `figaf-db` and `figaf-xsuaa` stay bound throughout rolling, eliminating the "what if user closes browser between unbind and rebind" footgun.

**When delete-then-push is still correct** (do NOT use rolling for these):
- Manifest *shape* changes that `cf push` can't reconcile in place: app rename, process-type change, route rename. Surface as a separate "Recreate (with downtime)" affordance with explicit confirm.
- A v2-style migration where you intentionally want a clean slate.

**How to apply:**
- New handler: `cf:pushApp({ app, strategy: "rolling" })` runs `cf push <app> --strategy rolling --vars-file vars.yml` from the deploy dir. Don't extend the existing `cf:push` (install-time bulk push) with an arg — keep install and update flows independently evolvable.
- Order for full update: (1) `cf update-service figaf-xsuaa -c xs-security.json` if diff non-empty → (2) rolling push `<ID>-app` → (3) rolling push `<ID>-router`. XSUAA update first so apps re-read VCAP_SERVICES on their next instance boot (which is the rolling push itself; no separate restage needed).
- For figaf-manager-approuter / figaf-manager itself (the wizard), the existing v2 XSUAA flow uses bind+restage rather than rolling — that's intentional and different. The rolling-vs-delete decision applies to *deployed Figaf Tool* apps, not the manager.
