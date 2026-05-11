"use strict";
// Wires the host-agnostic orchestrator (@figaf/core) to Electron IPC.
// Replaces the former main-process/bridge.js (which inlined everything).
//
// register({ ipcMain, getWindow }) → for each handler key returned by
// createOrchestrator, register an ipcMain.handle(channel, payload). Streamed
// events from the orchestrator (cli:line, cli:install, cf:loggedIn, …) are
// forwarded to the renderer via webContents.send.

const { createOrchestrator } = require("@figaf/core");
const { createHost } = require("./host.electron");

let orchestrator = null;

function register({ ipcMain, getWindow }) {
  const host = createHost({ getWindow });

  function send(channel, payload) {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  orchestrator = createOrchestrator({ host, send });

  for (const [channel, handler] of Object.entries(orchestrator.handlers)) {
    ipcMain.handle(channel, (_evt, payload) => handler(payload || {}));
  }
}

function dispose() {
  if (orchestrator) {
    try { orchestrator.dispose(); } catch {}
    orchestrator = null;
  }
}

module.exports = { register, dispose };
