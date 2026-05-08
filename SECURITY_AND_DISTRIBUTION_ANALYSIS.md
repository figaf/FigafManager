# Security & Distribution Strategy for Figaf Installer

**Date:** 2026-05-04  
**Participants:** Alexandru-Daniel Florea, Claude Code

## Problem Statement

The Figaf Installer provides excellent visual UX for deploying the Figaf Tool to SAP BTP Cloud Foundry, but distributing it as a desktop app (Electron .exe) creates security concerns:

- Enterprise IT teams are risk-averse toward unsigned executables, especially those spawning terminal commands
- Installing another app on company computers requires security review and approval
- Client companies need confidence that the app is trustworthy and doesn't overreach

## Core Tradeoff

**Every step taken to lower trust requirements shifts work back onto the user.**

Each distribution path trades convenience for security posture and operational complexity.

---

## Recommended Distribution Paths

### Path 1: BTP-Hosted App (Long-term recommended) ⭐ Best for roadmap

Deploy the installer as a `cf push`'d app inside the customer's own BTP subaccount.

**How it works:**
- Customer runs a bootstrap command: `cf push figaf-installer`
- Opens the UI in their own subaccount at `https://<id>.<domain>/admin`
- Clicks through the visual wizard (same React UI as today)
- All actions execute against their own BTP/CF with service bindings

**Strengths:**
- Nothing leaves the customer's BTP boundary
- No Figaf-side credentials, no token handoff
- Natural home for future roadmap features (manage/update, IS integration, deployment admin)
- Becomes a persistent admin console, not a one-shot installer

**Effort:** Medium. Wrap existing JSX in an Express server, handle service bindings. Foundational shift but aligned with future vision.

**Security win:** Eliminates the "trusting an external vendor with subaccount access" concern entirely.

---

### Path 2: Cloud Shell UI (Quickest win)

Run the wizard inside BTP Cloud Shell, a pre-authenticated Linux container users already have access to.

**How it works:**
- Customer opens Cloud Shell in their BTP cockpit
- Runs: `curl figaf.com/install.sh | bash`
- Local Node server starts, renders React UI in browser tab
- Pre-authenticated `btp` and `cf` CLIs are available, no login needed

**Strengths:**
- Minimal engineering: wrap JSX in Express, ship as a shell script
- Everything runs inside SAP's trusted boundary
- No client-side install, no credentials handled by Figaf

**Caveat:** Cloud Shell sessions have timeout limits; UX is slightly less polished than desktop for long deployments.

**Security win:** Strong — entire operation happens inside customer's SAP environment.

---

### Path 3: Browser-based SaaS with OAuth (Most elegant, highest effort)

Figaf-hosted web app at `install.figaf.com` that talks directly to BTP/CF REST APIs using browser-side OAuth tokens.

**How it works:**
- Customer visits install.figaf.com
- Grants OAuth consent to Figaf app
- Browser session holds the token (never sent to Figaf backend)
- Wizard calls BTP/CF REST APIs directly

**Strengths:**
- Same visual UX as today, runs anywhere
- Figaf backend is just a static site host—no credential access
- Most convenient for non-technical users
- Token stays in browser, never server-side

**Effort:** Significant. Every CLI operation in [main-process/bridge.js](main-process/bridge.js) must be mapped to REST. **The blocker: `cf push`** requires uploading droplets, managing buildpack flow, and streaming logs via CF v3 API—doable but substantial work.

**Security win:** Highest in theory—Figaf never touches user credentials. But requires engineering lift.

---

### Path 4: Portable + Signed Desktop App (Fallback for trusted environments)

Keep the Electron app, but ship as a portable signed executable with open-source code.

**How it works:**
- EV code-signing certificate ($300–500/yr)
- Reproducible builds + checksums published on GitHub
- Open-source the repo; link from figaf.com for security review
- Ship as portable .exe (no admin, no registry writes) instead of NSIS installer

**Strengths:**
- Preserves full UX and offline capability
- Lowest friction for developers and SMBs
- Code signing removes "Unknown publisher" warnings

**Caveat:** Even signed, large enterprises may still block—still requires trust in the vendor. Best suited as a *secondary* path for teams that have already approved Figaf.

---

## Recommendation: Phased Approach

1. **Phase 1 (Immediate):** Cloud Shell version as the public-facing default on figaf.com.
   - Lower engineering effort, strong security story.
   - Targets security-conscious enterprises.

2. **Phase 2 (Next quarter):** BTP-hosted app.
   - Foundational for future roadmap (manage, update, IS integration).
   - Makes Figaf a persistent admin tool, not a one-shot installer.

3. **Phase 3 (Optional):** Portable signed Electron as a convenience tier.
   - For developers and low-compliance environments.
   - Backed by open-source + EV signing.

## Marketing Angle

**"Deploy Figaf without leaving SAP"**

- Cloud Shell: Everything happens inside your BTP cockpit. No client installs, no external apps.
- BTP Booster: Figaf becomes part of your subaccount's admin dashboard.
- Zero credential handoff. Full transparency.

This positions Figaf as *more* trustworthy than traditional SaaS installers, not less.

---

## Files to Evolve

- [installer/app.jsx](installer/app.jsx) — Framework-agnostic; React UI can run in any Node server
- [main-process/bridge.js](main-process/bridge.js) — Operations map to REST APIs (for Path 3) or become Cloud Shell subprocesses (for Path 2)
- [package.json](package.json) — Electron config can be supplemented with a `scripts.cloud` entry
- New: `cloud-shell/server.js` or `btp-booster/manifest.yml` depending on path chosen

---

## Open Questions

- When do you envision the "manage/update" roadmap feature shipping? (Affects Path 1 vs. Path 2 priority)
- Do you expect many air-gapped / offline deployments? (If yes, keep Electron as primary)
- Is SAP BTP Booster registration feasible? (Unlocks better discoverability for Path 1)

