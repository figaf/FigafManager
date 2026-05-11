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

  // ─── WebSocket event bus ───────────────────────────────────────────────────

  const subscribers = new Map(); // channel → Set<handler>

  function openStream() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + "/stream");

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
      if (evt.code !== 4001) {
        // Reconnect on unexpected close (not an auth rejection)
        setTimeout(openStream, 2000);
      }
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
      loginStart:           function (a) { return rpc("cf:loginStart", a); },
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
      openPasscodeUrl: function (url) { window.open(url, "_blank", "noopener,noreferrer"); return Promise.resolve(); },
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
