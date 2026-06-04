---
name: New @figaf/ui static assets must be git-tracked, or both builds break silently
description: Untracked PNG/asset in packages/ui passes local builds but breaks the asar and the cloud zip on a fresh checkout — always git ls-files it in review
metadata:
  type: feedback
---

When a new static asset (PNG/SVG/etc.) is added under `packages/ui/` and served by both apps, confirm it is actually GIT-TRACKED (`git ls-files <path>` returns the path), not just present in the working tree.

**Why:** Both apps source UI assets from the `@figaf/ui` package. figaf-manager's `build-zip.js` stages `@figaf/ui` via `copyDir` from the WORKING TREE (so an untracked file is copied locally and the build appears to work), and the cloud server serves it from `installerDir = dirname(require.resolve("@figaf/ui/package.json"))`. figaf-local's electron-builder bundles `node_modules/@figaf/ui` into the asar — which only contains tracked files on a fresh checkout. Net effect: an untracked asset makes the local author's build pass while the merged branch / CI build / packaged exe ship a broken `<img>` in BOTH apps. This exactly happened with `saml-trust-cockpit.png` in the custom-IDP flow — the spec/plan said "already added by the user" but the file was `??` (untracked) and in zero commits.

**How to apply:** In any review that adds a UI asset, run `git ls-files packages/ui/<asset>` and `git check-ignore -v packages/ui/<asset>`. If untracked, that is a CRITICAL/blocking finding — the feature renders broken everywhere except the author's machine. The same dual-build trap applies to any file under `packages/ui` or `packages/deploy-templates` (electron-builder extraResources + build-zip staging both rely on tracked content). Plan checkboxes that claim an asset is "already added ✓" are NOT evidence it was committed — verify independently.