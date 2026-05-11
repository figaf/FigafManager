"use strict";
// Cloud HostAdapter — implements the contract documented in
// packages/core/orchestrator.js (@typedef HostAdapter).
//
// Each session gets its own user-data directory under $HOME/sessions/<sessionId>
// (the orchestrator writes the unpacked deploy template there). CLI binaries
// are bundled at /app/bin/{btp,cf} in the container; the dev fallback uses
// whatever is on PATH so a Mac/Windows dev machine can still run the server.
// pickFile/openExternal/readClipboard are no-ops on the server — the browser
// shim in cloud/client.js handles those client-side.

const path = require("path");
const fs = require("fs");
const os = require("os");

function createHost({ sessionId }) {
  return {
    isHosted: true,
    getUserDataDir: () => path.join(os.homedir(), "sessions", sessionId),

    resolveBinary(name) {
      const bundled = path.join(__dirname, "bin", name);
      if (!fs.existsSync(bundled) && process.env.NODE_ENV !== "production") {
        // Dev fallback: rely on PATH (Mac/Windows dev machines)
        return name;
      }
      return bundled;
    },

    openExternal: () => Promise.resolve(),
    pickFile:     () => Promise.resolve(null),
    readClipboard:() => Promise.resolve(""),

    resolveDeployTemplate: () => ({
      kind: "github",
      src:
        process.env.FIGAF_DEPLOYMENT_ZIP_URL ||
        "https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip",
    }),
  };
}

module.exports = { createHost };
