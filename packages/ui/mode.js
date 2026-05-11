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

  window.figafModeFlags = {
    isHosted: hosted,
    features: {
      cliInstall:   !hosted,  // figaf-local: install/locate btp+cf at runtime
      diskCheck:    !hosted,  // figaf-local: free-disk prereq probe
      windowChrome: !hosted,  // figaf-local: frameless titlebar + drag region
      selfDelete:   hosted,   // figaf-manager: "Delete this manager app" button on Done
    },
  };
})();
