/* global React */
// Self-update presentation layer.
//
// The version check itself runs ONCE in app.jsx and is stored in
// ctx.selfUpdate.check. This module provides:
//
//   window.figafTriggerSelfUpdate(check, setCtx)
//       Shared action used by BOTH the welcome-screen check row
//       (<SelfUpdateCheckRow/> in screen-setup.jsx) and the floating banner.
//       cloud   → opens the pre-flight modal (cf-target check + redeploy chain).
//       desktop → confirm, download the installer, hand off, quit.
//       Desktop progress/errors are mirrored into ctx.selfUpdate so whichever
//       view is mounted (row on welcome, banner elsewhere) can render them.
//
//   <SelfUpdateBanner/>
//       Floating CTA shown above non-welcome screens. On welcome the check row
//       owns the presentation, so app.jsx suppresses the banner there.

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

  // ── Shared action ──────────────────────────────────────────────────────────
  // Returns immediately for the cloud path (opens the modal). For desktop it
  // drives the download via ctx.selfUpdate.installing / installError so the
  // mounted view (row or banner) can reflect progress. On success the main
  // process quits the app, so the "installing" state is the last thing seen.
  async function triggerSelfUpdate(check, setCtx) {
    if (!check || !check.ok || !check.updateAvailable) return;
    const isCloud = check.host === "cloud";

    if (isCloud) {
      if (!(check.assets && check.assets.cloud)) return;
      setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), preflightOpen: true } }));
      return;
    }

    // Desktop
    if (!(check.assets && check.assets.desktop)) return;
    const ok = window.confirm(
      "Download and install Figaf Installer v" + check.latest + "?\n\n" +
      "The current app will close and the new installer will open."
    );
    if (!ok) return;

    setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), installing: true, installError: null } }));
    try {
      const r = await window.figaf.update.downloadAndInstallDesktop({ assetUrl: check.assets.desktop.url });
      if (!r || r.ok === false) {
        setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), installing: false, installError: (r && r.error) || "install failed" } }));
      }
      // On success the main process spawns the installer and quits the app —
      // this code does not run for long.
    } catch (e) {
      setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), installing: false, installError: (e && e.message) ? e.message : String(e) } }));
    }
  }

  window.figafTriggerSelfUpdate = triggerSelfUpdate;

  // ── Floating banner (non-welcome screens) ───────────────────────────────────
  function SelfUpdateBanner({ ctx, setCtx, suppress }) {
    const [dismissed, setDismissed] = React.useState(false);

    const flag = window.figafModeFlags && window.figafModeFlags.features && window.figafModeFlags.features.selfUpdateBanner;
    if (!flag) return null;
    if (suppress) return null;
    if (dismissed) return null;

    const su = ctx.selfUpdate || {};
    const check = su.check;

    // Desktop install in flight / failed — surfaced from ctx so the banner
    // reflects an action that may have been kicked off from the welcome row.
    if (su.installing) {
      return (
        <>
          <style>{STYLE}</style>
          <div className="sub-banner installing">
            <span className="grow">Downloading installer{check ? " v" + check.latest : ""}…</span>
          </div>
        </>
      );
    }
    if (su.installError) {
      return (
        <>
          <style>{STYLE}</style>
          <div className="sub-banner failed">
            <span className="grow"><strong>Update failed:</strong> {su.installError}</span>
            <button onClick={() => setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), installError: null } }))}>Dismiss</button>
          </div>
        </>
      );
    }

    if (!check || !check.ok || !check.updateAvailable) return null;
    const isCloud = check.host === "cloud";
    const hasAsset = isCloud ? !!(check.assets && check.assets.cloud) : !!(check.assets && check.assets.desktop);
    if (!hasAsset) return null;

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
          <button onClick={() => triggerSelfUpdate(check, setCtx)}>{isCloud ? "Update wizard…" : "Update installer…"}</button>
          <button className="dismiss" onClick={() => setDismissed(true)} title="Dismiss until next reload">×</button>
        </div>
      </>
    );
  }

  window.SelfUpdateBanner = SelfUpdateBanner;
})();
