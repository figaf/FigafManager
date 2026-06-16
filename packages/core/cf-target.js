"use strict";
// Parsers for `cf api` and `cf target` stdout. Pure-logic, no I/O. Used by
// the self-update pre-flight handler (update:selfTarget) to confirm the
// operator's cf-cli session is targeted at the manager's own CF coordinates
// before `cf push` self-redeploy.
//
// Output shape (live capture from cf-cli v8.18):
//
//   cf api:
//     API endpoint:   https://api.cf.us10-001.hana.ondemand.com
//     API version:    3.220.0
//
//   cf target (logged in):
//     API endpoint:   https://api.cf.us10-001.hana.ondemand.com
//     API version:    3.220.0
//     user:           afl@figaf.com
//     org:            9c492946trial
//     space:          dev
//
//   cf target (logged out, exit 1, stderr):
//     FAILED
//     Not logged in. Use 'cf.exe login' or 'cf.exe login --sso' to log in.
//
// Older cf-cli versions used lowercase keys ("api endpoint:") — both forms
// accepted via /i.

const KEY_API   = /^\s*api endpoint:\s+(\S.*?)\s*$/im;
const KEY_USER  = /^\s*user:\s+(\S.*?)\s*$/im;
const KEY_ORG   = /^\s*org:\s+(\S.*?)\s*$/im;
const KEY_SPACE = /^\s*space:\s+(\S.*?)\s*$/im;

function match(re, text) {
  const m = re.exec(text || "");
  return m ? m[1] : null;
}

function parseCfApi(text) {
  return { apiUrl: match(KEY_API, text) };
}

function parseCfTarget(text) {
  const apiUrl    = match(KEY_API, text);
  const user      = match(KEY_USER, text);
  const orgName   = match(KEY_ORG, text);
  const spaceName = match(KEY_SPACE, text);

  // Logged-in markers: explicit user line present (cf prints user only with
  // an active session) AND no "Not logged in" stderr marker in the text.
  const loggedOut = !user || /Not logged in/i.test(text || "");

  return {
    apiUrl,
    user:      loggedOut ? null : user,
    orgName:   loggedOut ? null : orgName,
    spaceName: loggedOut ? null : spaceName,
    loggedIn:  !loggedOut,
  };
}

// Normalize a CF API URL for string comparison: lowercase scheme + host,
// strip trailing slash. (VCAP_APPLICATION.cf_api and `cf api` output can
// differ on trailing slash; case differences are unlikely in practice but
// cheap to handle.)
function normalizeApiUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url));
    const host = u.host.toLowerCase();
    const scheme = u.protocol.toLowerCase();
    const pathname = u.pathname.replace(/\/$/, "");
    return `${scheme}//${host}${pathname}`;
  } catch {
    return String(url).replace(/\/+$/, "").toLowerCase();
  }
}

module.exports = { parseCfApi, parseCfTarget, normalizeApiUrl };
