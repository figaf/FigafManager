---
name: db-config-design
description: Design decisions for making packages/deploy-templates/db.json user-configurable per hyperscaler with trial-mode autodetection
metadata:
  type: project
---

Step 4 db.json configurability — design accepted 2026-05-19, not yet implemented:

**Architecture:**
- New IPC channel `config:writeDbConfig` + `config:readDbConfig`, mirroring `config:writeVars`/`config:readVars` pattern.
- Renderer sends structured input `{trial, provider, fields}`, NOT pre-built JSON. Orchestrator owns the schema map.
- Per-provider schema lives in new file `packages/core/db-schemas.js` so SAP-side schema drift is a one-file change.

**Provider plumbing:** thread `provider` through three paths — `applySubaccountSelection` return, single-CF auto-pick in `btp:listEnvInstances`, and `btp:selectSubaccount`. Add `provider: null` to `ctx.login` init. Clear it on GA-switch reset.

**Trial detection:** `/trial/i.test(state.globalAccountSubdomain)`, case-insensitive substring. Stored as `ctx.config.trialPg` (config not login), seeded lazily on ScreenConfig mount only if `undefined` so user overrides survive remounts.

**UI scope:** trial mode exposes only `engine_version` + `locale`. Hyperscaler mode exposes `engine_version`, `locale`, `storage`, `memory`, `backup_retention_period`, `multi_az` (hidden on GCP), `public_access`, `cross_region_backup` (GCP-only). `audit_log_level`, `maintenance_window`, `db_parameters`, `ignore_default_ips`, `allow_access` are written from orchestrator defaults — no UI.

**postgresql_extensions:** keep, NOT user-configurable. The Figaf Tool depends on uuid-ossp/pgcrypto/pg_trgm/etc. at runtime — exposing them is a footgun. Stripped on trial (broker rejects). Lives as a const in db-schemas.js.

**Why:** afl@figaf.com asked for "operator gets a sane deployment in two clicks" — explicitly NOT full JSON power-user editing. Trial autodetection + override checkbox is the UX. See [[v2-xsuaa-implementation]] for similar in-place schema discipline.

**How to apply:** when implementation begins, scope = both apps + shared core. New channel must be exposed in both preload.js and client.js. ScreenConfig section sits between PostgreSQL plan picker and footer; uses existing 2-col grid and `--ink-3` eyebrow styling. Validation: disable Next when `!trialPg && !provider` (unknown provider, non-trial).
