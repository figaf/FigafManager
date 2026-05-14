---
name: HostAdapter extensions log
description: Per-feature index of HostAdapter methods added beyond the v1 base contract, with dual-implementation status
type: reference
---

The HostAdapter contract is the only seam between the two apps' host environments. Every new capability MUST be added to the @typedef in `packages/core/orchestrator.js` first, then implemented in BOTH adapters (with intentional null-returners on adapters where the feature is N/A).

## Current additions beyond the v1 base

| Method | Added in | Cloud impl | Electron impl | Notes |
|---|---|---|---|---|
| `resolveManagerApprouterDir()` | v2 commit 5 | `__dirname/manager-approuter` with dev fallback to `<workspace>/packages/manager-approuter/` | returns `null` | Hosted-only feature; Electron stub keeps shape symmetric |

When adding new HostAdapter methods:
1. Update @typedef in `packages/core/orchestrator.js` (single source of truth)
2. Implement in `apps/figaf-manager/host.cloud.js`
3. Implement in `apps/figaf-local/main-process/host.electron.js` (even if just `() => null` or similar safe default)
4. Gate orchestrator handlers that call it on `host.isHosted` if cloud-only, OR check for null returns and fail safely
