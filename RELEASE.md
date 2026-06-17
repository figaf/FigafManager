# Cutting a release

Releases are automated by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)).
The **git tag is the single source of truth** for the version — you do **not**
edit `package.json` by hand. You publish a release on GitHub; CI stamps the
tag's version into the build, builds both installers, and attaches them.

## Version scheme

`vMAJOR.MINOR.PATCH` — standard semver (electron-builder requires it). We use
year-month as the major: `v26.5.0`, `v26.5.1` … as pre-production iterations,
switching to `v26.6.0` for the first production-ready release.

## One-time setup

Already done — nothing to configure. Single-repo: artifacts attach to this
repo's own Releases tab via the built-in Actions token. No Personal Access
Token, no secrets.

## Steps to release version vX.Y.Z

1. **Draft the release on GitHub** (no code changes needed):
   - Go to https://github.com/figaf/FigafManager/releases → **Draft a new release**.
   - **Choose a tag** → type `vX.Y.Z` (e.g. `v26.5.1`) → "Create new tag on publish".
   - Title + release notes as you like. Tick **"Set as a pre-release"** for
     iterations you don't want offered as the latest (see note below).
   - Click **Publish release**.

2. **Watch it build** (~10 min) under the
   [Actions tab](https://github.com/figaf/FigafManager/actions):
   - `verify` — checks the tag is valid semver, runs unit tests. Gates the builds.
   - `build-manager` (Linux) — stamps the version, attaches `figaf-manager-app-X.Y.Z.zip`
     **and** the CF `manifest.yml`.
   - `build-desktop` (Windows) — stamps the version, attaches the **portable**
     `Figaf-Installer-X.Y.Z-x64.exe` (the only Windows target built).

3. **Done.** The artifacts now hang off the release. Running wizards pick
   up the update automatically:
   - **figaf-manager** dynos show the update banner / welcome-screen row within a
     page refresh and can redeploy themselves in place.
   - **figaf-local** installs show the same row; clicking it opens the release
     page so the user can download the new portable and replace their copy (a
     running portable can't overwrite itself in place).

## The committed `package.json` version

`package.json` holds the **dev/in-progress** version (currently `26.5.0`); it is
*not* what releases use — CI overrides it from the tag at build time. After
shipping a release you may optionally bump the committed version to the next
planned one to keep local dev output sensible, but it is not required for the
release pipeline.

## What each artifact is

| Artifact | Built by | Consumed by |
|---|---|---|
| `figaf-manager-app-X.Y.Z.zip` | `npm run build:manager` | The cloud wizard's self-redeploy (`update:pushSelf`) and first-time cockpit upload |
| `manifest.yml` | committed in repo (published verbatim) | First-time cockpit "Deploy Application" deployment descriptor |
| `Figaf-Installer-X.Y.Z-x64.exe` (portable) | `npm run build:local` | First-time download, and the desktop self-update target (matched by `DESKTOP_ASSET_REGEX`; the row opens the release page to download it) |

## Gotchas

- **Tag must be valid semver.** `vMAJOR.MINOR.PATCH` (three numeric parts,
  e.g. `v26.5.1`). The `verify` job rejects anything else — electron-builder
  refuses to build a non-semver version. A bare `v2606` or `v26.5` will fail.
- **Pre-release / draft releases are skipped** by the self-update check — it
  queries `releases/latest`, which GitHub only points at published,
  non-prerelease releases. Tick "Set as a pre-release" to stage artifacts
  without offering them to users yet.
- **The desktop installer is unsigned.** Windows SmartScreen will warn on
  first launch of each new version. Code signing is a separate, future task.
- **Re-running a release** (e.g. a build job failed and you re-ran it) is
  safe: `gh release upload --clobber` overwrites the existing asset.

## Pointing at a different release repo (staging / forks)

The wizard reads releases from `figaf/FigafManager` by default. Override with
the `FIGAF_RELEASE_REPO` env var (e.g. in `apps/figaf-manager/manifest.yml`)
to point a test deployment at a fork's releases. See
[packages/core/release-config.js](packages/core/release-config.js).
