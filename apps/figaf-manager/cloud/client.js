// window.figaf browser shim for the CF-hosted context.
// Loaded by cloud/index.html BEFORE app.jsx, AFTER the mode-flag injection script.
// Mirrors the IPC surface in main-process/preload.js, but over fetch + WebSocket:
//   RPC calls  → POST /rpc/:channel  (session cookie travels same-origin)
//   Events     → WebSocket /stream   (server pushes { channel, payload } JSON frames)
//
// Differences from the Electron preload:
//   shell.openExternal / openPasscodeUrl  → window.open (user's local browser)
//   shell.readClipboard                   → navigator.clipboard.readText()
//   window.minimize / toggleMax / close   → no-ops

(function () {
  "use strict";

  // ─── Auth-kick handling ────────────────────────────────────────────────────
  // Plan §1.5 + §1.7 commit 7. The cloud server can reject this client at
  // two seams:
  //   - HTTP 401 from POST /rpc/* when the auth cookie is missing/expired.
  //   - WS close code 4003 (or pre-upgrade 401) from /stream for the same.
  // Either signal means: drop to /setup, but first fire a synthetic
  // btp:browserAuth event so the renderer can paint a banner if the wizard
  // is mid-flow. Idempotent — multiple kicks queue one redirect.

  var kicked = false;
  function handleAuthKick(reason) {
    if (kicked) return;
    kicked = true;
    try { window.sessionStorage.setItem("figaf:auth-kicked", "1"); } catch (_) {}
    var bus = subscribers.get("btp:browserAuth");
    if (bus) bus.forEach(function (h) { try { h({ reason: reason || "kicked" }); } catch (_) {} });
    // Brief delay so the banner/toast has time to render before navigation.
    setTimeout(function () {
      try { window.location.href = "/setup"; } catch (_) {}
    }, 800);
  }

  // ─── WebSocket event bus ───────────────────────────────────────────────────

  var subscribers = new Map(); // channel → Set<handler>

  function openStream() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/stream");

    ws.addEventListener("open", function () {
      console.log("[figaf] stream connected");
    });

    ws.addEventListener("message", function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.pong) return;
        var handlers = subscribers.get(msg.channel);
        if (handlers) handlers.forEach(function (h) { h(msg.payload); });
      } catch (_) {}
    });

    ws.addEventListener("close", function (evt) {
      // 4003: server-issued unauthenticated (post-upgrade) — auth-kick redirect.
      // Note: when the server rejects pre-upgrade with HTTP 401, the browser
      // surfaces it as a generic close + error rather than a clean 4003. We
      // detect "never opened, very fast close" as a fallback below.
      if (evt.code === 4003) {
        handleAuthKick("ws-4003");
        return;
      }
      if (evt.code === 4001) {
        // Legacy/no-session: leave as-is (no reconnect, no redirect).
        return;
      }
      // Reconnect on unexpected close (e.g., dyno restart). Slight back-off.
      if (!kicked) setTimeout(openStream, 2000);
    });

    ws.addEventListener("error", function () {});
  }

  openStream();

  // ─── RPC helper ───────────────────────────────────────────────────────────

  function rpc(channel, args) {
    return fetch("/rpc/" + encodeURIComponent(channel), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args != null ? args : {}),
      credentials: "same-origin",
    }).then(function (r) {
      if (r.status === 401) {
        handleAuthKick("rpc-401");
        return { ok: false, error: "unauthenticated" };
      }
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
    });
  }

  // ─── window.figaf ─────────────────────────────────────────────────────────

  window.figaf = {
    prereq: {
      whichBtp:             function ()  { return rpc("prereq:whichBtp"); },
      whichCf:              function ()  { return rpc("prereq:whichCf"); },
      getCliPaths:          function ()  { return rpc("prereq:getCliPaths"); },
      clearCliPath:         function (a) { return rpc("prereq:clearCliPath", a); },
      installBtp:           function ()  { return rpc("prereq:installBtp"); },
      installCf:            function ()  { return rpc("prereq:installCf"); },
      locateCli:            function (a) { return rpc("prereq:locateCli", a); },
      dockerHub:            function ()  { return rpc("prereq:dockerHub"); },
      disk:                 function ()  { return rpc("prereq:disk"); },
      openBtpDownloadPage:  function ()  { return rpc("prereq:openBtpDownloadPage"); },
    },

    btp: {
      loginStart:           function ()  { return rpc("btp:loginStart"); },
      submitChoice:         function (a) { return rpc("btp:submitChoice", a); },
      cancelLogin:          function ()  { return rpc("btp:cancelLogin"); },
      selectGlobalAccount:  function (a) { return rpc("btp:selectGlobalAccount", a); },
      logout:               function ()  { return rpc("btp:logout"); },
      listEnvInstances:     function ()  { return rpc("btp:listEnvInstances"); },
      listUsers:            function ()  { return rpc("btp:listUsers"); },
      assignRole:           function (a) { return rpc("btp:assignRole", a); },
    },

    cf: {
      loginStart:           function (apiUrl) { return rpc("cf:loginStart", { apiUrl: apiUrl }); },
      submitPasscode:       function (a) { return rpc("cf:submitPasscode", a); },
      logout:               function ()  { return rpc("cf:logout"); },
      targetOrgSpace:       function ()  { return rpc("cf:targetOrgSpace"); },
      domains:              function ()  { return rpc("cf:domains"); },
      marketplacePostgresql:function ()  { return rpc("cf:marketplacePostgresql"); },
      createService:        function (a) { return rpc("cf:createService", a); },
      service:              function (a) { return rpc("cf:service", a); },
      pollService:          function (a) { return rpc("cf:pollService", a); },
      push:                 function ()  { return rpc("cf:push"); },
      deleteApp:            function (a) { return rpc("cf:deleteApp", a); },
      // v2 XSUAA upgrade — see auth-gate-implementation-plan.md §2.
      createXsuaa:           function ()  { return rpc("cf:createXsuaa"); },
      pushManagerApprouter:  function ()  { return rpc("cf:pushManagerApprouter"); },
      mapRoute:              function (a) { return rpc("cf:mapRoute", a); },
      unmapRoute:            function (a) { return rpc("cf:unmapRoute", a); },
      restage:               function (a) { return rpc("cf:restage", a); },
      uninstallManager:      function (a) { return rpc("cf:uninstallManager", a || {}); },
    },

    xsuaa: {
      upgradeStatus:                 function ()  { return rpc("xsuaa:upgradeStatus"); },
      assignRoleCollectionPreflight: function ()  { return rpc("xsuaa:assignRoleCollectionPreflight"); },
    },

    config: {
      dockerHubLatestBtpTag:function ()  { return rpc("config:dockerHubLatestBtpTag"); },
      dockerHubBtpTags:     function ()  { return rpc("config:dockerHubBtpTags"); },
      deployDir:            function ()  { return rpc("config:deployDir"); },
      readVars:             function ()  { return rpc("config:readVars"); },
      writeVars:            function (a) { return rpc("config:writeVars", a); },
    },

    shell: {
      openExternal:    function (url) { window.open(url, "_blank", "noopener,noreferrer"); return Promise.resolve(); },
      openPasscodeUrl: function (landscape) {
        var lp = (landscape || "").replace(/^cf-/, "cf.");
        var url = "https://login." + lp + ".hana.ondemand.com/passcode";
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve({ ok: true, url: url });
      },
      readClipboard:   function () {
        if (navigator.clipboard && navigator.clipboard.readText) {
          return navigator.clipboard.readText().then(function (text) { return { ok: true, text: text }; });
        }
        return Promise.resolve({ ok: false, text: "" });
      },
    },

    // No-ops: there is no native window to control in a browser tab
    window: {
      minimize:  function () {},
      toggleMax: function () {},
      close:     function () {},
    },

    on: function (channel, handler) {
      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(handler);
      return function () {
        var s = subscribers.get(channel);
        if (s) s.delete(handler);
      };
    },
  };
})();
