// Mode + feature-flag module for the shared renderer.
// Loaded once per page, before app.jsx, by both apps' index.html shells.
//
// In cloud mode, server.js injects `window.figafMode = "hosted"` before this
// script runs. In Electron mode, that flag is absent, so isHosted defaults to
// false. Add new conditionals here rather than scattering `isHosted` ternaries
// across screens.

(function () {
  "use strict";
  var hosted = (typeof window !== "undefined") && window.figafMode === "hosted";
  // v2: window.figafXsuaaMode is injected by server.js (hosted) if VCAP_SERVICES
  // has an xsuaa binding. The upgrade is only OFFERABLE in the token-gate
  // (pre-upgrade) world AND only after a deploy has succeeded — so the
  // feature flag here is "the upgrade button should appear" not "the wizard
  // is already in XSUAA mode." app.jsx reads it after ctx.deployDone is set.
  var xsuaaMode = (typeof window !== "undefined") && window.figafXsuaaMode === true;

  window.figafModeFlags = {
    isHosted: hosted,
    isXsuaaMode: xsuaaMode,
    features: {
      cliInstall:    !hosted,           // figaf-local: install/locate btp+cf at runtime
      diskCheck:     !hosted,           // figaf-local: free-disk prereq probe
      windowChrome:  !hosted,           // figaf-local: frameless titlebar + drag region
      selfDelete:    hosted,            // figaf-manager: "Delete this manager app" button on Done
      // v2: in hosted+token mode (the upgrade hasn't run yet), surface the
      // "Enable persistent SSO login" button on the Done screen. In XSUAA
      // mode the upgrade is already done — flag is false. In Electron the
      // wizard doesn't deploy itself, so the entire concept is N/A.
      xsuaaUpgrade:  hosted && !xsuaaMode,
    },
  };
})();
