"use strict";
// Pure helper: derive the CF "landscape" label from a Cloud Foundry API URL.
// No CLI, no I/O. Used by the CF-only login path (skip BTP) to reconstruct the
// landscape needed for the passcode URL + display, since there is no btp
// environment-instance to read it from.
//
//   https://api.cf.us10.hana.ondemand.com      -> "cf.us10"
//   https://api.cf.us10-001.hana.ondemand.com  -> "cf.us10-001"
//   custom / non-standard host                 -> ""   (caller degrades gracefully)
//
// NOTE: a byte-identical copy of `landscapeFromApiUrl` is inlined in
// packages/ui/screens/screen-login.jsx because the renderer has no bundler and
// cannot `require()` this module. Keep the two in sync.

function landscapeFromApiUrl(apiUrl) {
  try {
    let s = String(apiUrl || "").trim();
    if (!s) return "";
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    const host = new URL(s).hostname.toLowerCase();
    const m = /^api\.(.+)\.hana\.ondemand\.com$/.exec(host);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

module.exports = { landscapeFromApiUrl };
