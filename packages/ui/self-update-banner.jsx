/* global React */
// <SelfUpdateBanner/> — top-of-wizard banner that surfaces a newer Figaf
// Installer release when GitHub has one published.
//
// On mount: calls window.figaf.update.checkSelf() once. If updateAvailable,
// renders a 1-line banner with version delta + Update button + Dismiss x.
//
// Click behavior depends on host:
//   - cloud   → opens the existing UpdatePreflightModal (which carries the
//               cf-target check + full download/extract/push pipeline).
//   - desktop → window.confirm + window.figaf.update.downloadAndInstallDesktop()
//               which downloads the installer and launches it; the current
//               app exits.
//
// Suppression: caller passes `suppress: true` (computed via figafIsLongRunningFlow
// in app.jsx). The banner renders nothing in that case, so we don't pester
// operators mid-deploy.
//
// Per-session dismiss only — we don't persist. A page reload re-evaluates.

(function () {
  "use strict";

  var STYLE = `
    .sub-banner {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 14px; margin: 8px 12px 0;
      background: var(--fg-blue-softer, #F3F7FD);
      border: 1px solid var(--fg-blue, #1565D8);
      border-radius: 8px;
      font-size: 12.5px; color: var(--ink-1, #1F2937);
    }
    .sub-banner strong { color: var(--fg-blue, #1565D8); }
    .sub-banner .grow { flex: 1; }
    .sub-banner button {
      padding: 5px 12px; border-radius: 5px; font-size: 12px; cursor: pointer;
      border: 1px solid var(--fg-blue, #1565D8); background: var(--fg-blue, #1565D8); color: #fff;
    }
    .sub-banner button:hover { background: var(--fg-blue-hover, #0F52B3); }
    .sub-banner .dismiss {
      background: transparent; color: var(--ink-3, #6B7280);
      border: 0; font-size: 16px; padding: 0 6px; cursor: pointer;
    }
    .sub-banner.installing { background: var(--surface-2, #F8FAFC); }
    .sub-banner.failed     { background: #FEF2F2; border-color: var(--danger, #DC2626); }
    .sub-banner.failed strong { color: var(--danger, #DC2626); }
  `;

  function SelfUpdateBanner({ ctx, setCtx, currentStepId, suppress }) {
    const [check, setCheck]         = React.useState(null);
    const [dismissed, setDismissed] = React.useState(false);
    const [installing, setInstalling] = React.useState(false);
    const [installError, setInstallError] = React.useState(null);

    // Run the check once on mount. Fails open: any error leaves check=null
    // and the banner stays hidden.
    React.useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const r = await window.figaf.update.checkSelf();
          if (!cancelled) setCheck(r);
        } catch (_) { /* leave check=null */ }
      })();
      return () => { cancelled = true; };
    }, []);

    // Feature flag + suppression + dismiss + "do we actually have an update?"
    const flag = window.figafModeFlags && window.figafModeFlags.features && window.figafModeFlags.features.selfUpdateBanner;
    if (!flag) return null;
    if (suppress) return null;
    if (dismissed) return null;
    if (!check || !check.ok || !check.updateAvailable) return null;

    const isCloud = check.host === "cloud";
    const hasAsset = isCloud
      ? !!(check.assets && check.assets.cloud)
      : !!(check.assets && check.assets.desktop);
    if (!hasAsset) return null; // release exists but is missing our artifact

    async function onUpdate() {
      if (isCloud) {
        // Open the existing PR 2/3/4 modal — it runs preflight, checkSelf
        // again (re-using the same cached state), and the full chain.
        setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), preflightOpen: true } }));
        return;
      }
      // Desktop: confirm, download installer, hand off, quit.
      const ok = window.confirm(
        "Download and install Figaf Installer v" + check.latest + "?\n\n" +
        "The current app will close and the new installer will open."
      );
      if (!ok) return;
      setInstalling(true);
      setInstallError(null);
      try {
        const r = await window.figaf.update.downloadAndInstallDesktop({
          assetUrl: check.assets.desktop.url,
        });
        if (!r || r.ok === false) {
          setInstalling(false);
          setInstallError((r && r.error) || "install failed");
          return;
        }
        // On success the main process spawns the installer and quits the
        // current app — we won't see this code run for long.
      } catch (e) {
        setInstalling(false);
        setInstallError(e && e.message ? e.message : String(e));
      }
    }

    if (installing) {
      return (
        <>
          <style>{STYLE}</style>
          <div className="sub-banner installing">
            <span className="grow">Downloading installer v{check.latest}…</span>
          </div>
        </>
      );
    }
    if (installError) {
      return (
        <>
          <style>{STYLE}</style>
          <div className="sub-banner failed">
            <span className="grow">
              <strong>Update failed:</strong> {installError}
            </span>
            <button onClick={() => { setInstallError(null); }}>Dismiss</button>
          </div>
        </>
      );
    }
    return (
      <>
        <style>{STYLE}</style>
        <div className="sub-banner">
          <span className="grow">
            <strong>Installer update available:</strong> v{check.current} → v{check.latest}
            {check.releaseUrl && (
              <>{" "}·{" "}
                <a href={check.releaseUrl} target="_blank" rel="noopener noreferrer">release notes</a>
              </>
            )}
          </span>
          <button onClick={onUpdate}>{isCloud ? "Update wizard…" : "Update installer…"}</button>
          <button className="dismiss" onClick={() => setDismissed(true)} title="Dismiss until next reload">×</button>
        </div>
      </>
    );
  }

  window.SelfUpdateBanner = SelfUpdateBanner;
})();
