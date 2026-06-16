# Cutting a release

Releases are automated by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)).
You publish a release on GitHub; CI builds both installers and attaches them.
No local builds, no manual uploads.

## One-time setup

Already done — nothing to configure. Single-repo: artifacts attach to this
repo's own Releases tab via the built-in Actions token. No Personal Access
Token, no secrets.

## Steps to release version X.Y.Z

1. **Bump the version in both app manifests** (they must match the tag):
   - `apps/figaf-manager/package.json` → `"version": "X.Y.Z"`
   - `apps/figaf-local/package.json` → `"version": "X.Y.Z"`

   These two drive the artifact filenames *and* the self-update version
   comparison, so they are the source of truth. (Bump the root
   `package.json` too for tidiness; it is not hard-checked.)

2. **Commit and push to `master`:**
   ```
   git add apps/figaf-manager/package.json apps/figaf-local/package.json package.json
   git commit -m "chore: release vX.Y.Z"
   git push figaf master
   ```

3. **Draft the release on GitHub:**
   - Go to https://github.com/figaf/FigafManager/releases → **Draft a new release**.
   - **Choose a tag** → type `vX.Y.Z` → "Create new tag on publish".
   - Title + release notes as you like.
   - Click **Publish release**.

4. **Watch it build** (~10 min) under the
   [Actions tab](https://github.com/figaf/FigafManager/actions):
   - `verify` — confirms the tag matches both package.json versions, runs tests.
     If the tag ≠ versions, the whole run fails here and nothing is attached.
   - `build-manager` (Linux) — attaches `figaf-manager-app-X.Y.Z.zip`.
   - `build-desktop` (Windows) — attaches `Figaf-Installer-Setup-X.Y.Z-x64.exe`.

5. **Done.** The two artifacts now hang off the release. Running wizards pick
   up the update automatically:
   - **figaf-manager** dynos and **figaf-local** installs show the update
     banner within a page refresh (they poll `releases/latest`).

## What each artifact is

| Artifact | Built by | Consumed by |
|---|---|---|
| `figaf-manager-app-X.Y.Z.zip` | `npm run build:manager` | The cloud wizard's self-redeploy (`update:pushSelf`) and first-time cockpit upload |
| `Figaf-Installer-Setup-X.Y.Z-x64.exe` | `npm run build:local` | The desktop self-update (`update:downloadAndInstallDesktop`) and first-time download |

## Gotchas

- **Tag must match versions.** `v1.2.0` requires both app `package.json`
  versions to read exactly `1.2.0`. The `verify` job enforces this.
- **Pre-release / draft releases are skipped** by the self-update check — it
  queries `releases/latest`, which GitHub only points at published,
  non-prerelease releases. Mark a release "pre-release" to stage artifacts
  without offering them to users.
- **The desktop installer is unsigned.** Windows SmartScreen will warn on
  first launch of each new version. Code signing is a separate, future task.
- **Re-running a release** (e.g. a build job failed and you re-ran it) is
  safe: `gh release upload --clobber` overwrites the existing asset.

## Pointing at a different release repo (staging / forks)

The wizard reads releases from `figaf/FigafManager` by default. Override with
the `FIGAF_RELEASE_REPO` env var (e.g. in `apps/figaf-manager/manifest.yml`)
to point a test deployment at a fork's releases. See
[packages/core/release-config.js](packages/core/release-config.js).
