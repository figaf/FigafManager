"use strict";
// Wizard-scoped approuter that fronts figaf-manager once XSUAA is enabled.
//
// Responsibilities:
//   1. Run @sap/approuter so that any request to the public route is
//      authenticated against the figaf-manager-xsuaa service before being
//      forwarded to the manager's internal route (`figaf-manager-internal`
//      destination — bound via VCAP_SERVICES at runtime, see manifest).
//   2. Expose two unauthenticated health endpoints:
//        - /_health         → always 200, no upstream calls. Lets the wizard
//                             poll "is the approuter up?" during phase 1.
//        - /_manager-health → proxy GET to manager's /health. Returns 200 if
//                             the manager is responsive, 503 otherwise. Used
//                             by maintenance.html to detect when the manager
//                             has finished its restage and is ready.
//   3. During the manager's restage window, render maintenance.html for any
//      authenticated browser request to / (and any path other than /_health
//      and /_manager-health). Approuter handles the IAS dance; we layer the
//      maintenance page detection ahead of approuter's forward.
//
// All routing for normal traffic lives in xs-app.json. The middleware here
// only intercepts the health probes and (optionally) the maintenance gating.

const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const approuter = require("@sap/approuter");

const PORT = parseInt(process.env.PORT || "5000", 10);
const MAINTENANCE_HTML_PATH = path.join(__dirname, "maintenance.html");

// `static/` dir is what xs-app.json's `localDir: "static"` route for /_health
// points at. We pre-create it with a tiny health file so approuter can serve
// the unauthenticated probe without any custom code.
const STATIC_DIR = path.join(__dirname, "static");
try {
  fs.mkdirSync(STATIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATIC_DIR, "_health"), "ok\n");
} catch (_) {
  /* directory may already exist or be read-only — ignore */
}

// Resolve the internal manager destination URL once at boot. In a real CF
// deployment this is set via xs-app.json's destination + manifest binding.
// We accept FIGAF_MANAGER_INTERNAL_URL as a runtime override for local
// testing where the wizard isn't bound through xs-app.json.
const MANAGER_INTERNAL_URL =
  process.env.FIGAF_MANAGER_INTERNAL_URL ||
  process.env.destinations_figaf_manager_internal_url ||
  "";

// Probe manager's /health endpoint and return a normalized status object.
// We keep this lightweight: a 3 s connect timeout + a 5 s overall budget.
function probeManager() {
  return new Promise((resolve) => {
    if (!MANAGER_INTERNAL_URL) {
      return resolve({ ok: false, reason: "no-internal-url" });
    }
    let url;
    try { url = new URL("/health", MANAGER_INTERNAL_URL); }
    catch (e) { return resolve({ ok: false, reason: "bad-url" }); }

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: 3000 }, (res) => {
      res.resume(); // drain
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, reason: e.code || e.message }));
    setTimeout(() => { try { req.destroy(); } catch {} resolve({ ok: false, reason: "budget" }); }, 5000);
  });
}

// Build the approuter and wire our extension. We use approuter's `extensions`
// hook to intercept /_health and /_manager-health before its own routing.
const ar = approuter();

ar.beforeRequestHandler.use("/_health", function (req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end("ok\n");
});

ar.beforeRequestHandler.use("/_manager-health", async function (req, res) {
  const r = await probeManager();
  res.statusCode = r.ok ? 200 : 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(r));
});

// If the maintenance flag is set (operator passes FIGAF_MANAGER_MAINTENANCE=1
// before restaging the manager), short-circuit non-health GETs to the
// maintenance page. Approuter still handles auth — we only intercept after
// the IAS handshake has succeeded.
ar.beforeRequestHandler.use(function (req, res, next) {
  if (process.env.FIGAF_MANAGER_MAINTENANCE !== "1") return next();
  if (req.method !== "GET") return next();
  if (req.url === "/_health" || req.url === "/_manager-health") return next();
  // Serve maintenance page (cached read at module load would be brittle if
  // we ever rotate it during upgrade; re-read on each hit is acceptable for
  // the short maintenance window).
  let html;
  try { html = fs.readFileSync(MAINTENANCE_HTML_PATH, "utf8"); }
  catch (_) { return next(); }
  res.statusCode = 503;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "10");
  res.end(html);
});

ar.start({ port: PORT });
console.log("figaf-manager-approuter listening on :" + PORT);
console.log("manager internal URL: " + (MANAGER_INTERNAL_URL || "(unset — /_manager-health will 503)"));
