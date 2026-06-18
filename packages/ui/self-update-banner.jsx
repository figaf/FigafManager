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
//       desktop → opens the GitHub release page in the browser. The desktop
//                 asset is the PORTABLE exe, which a running copy can't
//                 overwrite in place, so the operator downloads the new
//                 portable and replaces their copy manually.
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
  `;

  // ── Shared action ──────────────────────────────────────────────────────────
  // Cloud → opens the pre-flight modal (redeploy chain). Desktop → opens the
  // GitHub release page so the operator can download the new portable exe and
  // replace their copy. A running portable can't overwrite itself in place, so
  // there is no in-app download/relaunch on desktop.
  async function triggerSelfUpdate(check, setCtx) {
    if (!check || !check.ok || !check.updateAvailable) return;
    const isCloud = check.host === "cloud";

    if (isCloud) {
      if (!(check.assets && check.assets.cloud)) return;
      setCtx(c => ({ ...c, selfUpdate: { ...(c.selfUpdate || {}), preflightOpen: true } }));
      return;
    }

    // Desktop — send the operator to the release page to grab the new portable.
    // Prefer the deep-link to the matched asset; fall back to the release page.
    const url =
      (check.assets && check.assets.desktop && check.assets.desktop.url) ||
      check.releaseUrl ||
      null;
    if (!url) return;
    try {
      if (window.figaf && window.figaf.shell && window.figaf.shell.openExternal) {
        await window.figaf.shell.openExternal(url);
      } else if (typeof window.open === "function") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (_e) {
      // Best-effort: opening a browser tab should never throw into the UI.
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
          <button onClick={() => triggerSelfUpdate(check, setCtx)}>{isCloud ? "Update" : "Download"}</button>
          <button className="dismiss" onClick={() => setDismissed(true)} title="Dismiss until next reload">×</button>
        </div>
      </>
    );
  }

  window.SelfUpdateBanner = SelfUpdateBanner;
})();
