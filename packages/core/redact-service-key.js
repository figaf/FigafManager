"use strict";
// Per-line redactor used by the cf:serviceKey handler in orchestrator.js.
// Mutates an it-rt service-key JSON line by replacing sensitive values with
// "********" so the cli:line stream (which feeds the TerminalDrawer in the
// UI and the server-side audit log) never carries client secrets.
//
// The orchestrator handler still returns the UNREDACTED parsed JSON via its
// return value — that is what the screen displays + copies to clipboard.
// The redaction is per-line because the cf output is streamed line by line;
// matching on whole JSON would force buffering and break live progress.

// Marker keys: when one of these appears as a JSON key on the line, the
// value is masked. Case-insensitive substring match.
const SENSITIVE_KEYS = [
  "clientsecret",
  "client_secret",
  "clientid",
  "client_id",
  "tokenurl",
  "token_url",
  "password",
];

// Lines that should always be replaced wholesale (no safe partial redaction).
function shouldFullyMask(lower) {
  // PEM headers/footers and any URL that embeds a "clientsecret=" query param.
  if (/^[\s-]*-----begin /.test(lower)) return true;
  if (/clientsecret=/.test(lower) || /client_secret=/.test(lower)) return true;
  return false;
}

function redactServiceKeyLine(line) {
  if (typeof line !== "string") return line;
  const lower = line.toLowerCase();
  if (shouldFullyMask(lower)) return "********";

  for (const key of SENSITIVE_KEYS) {
    if (!lower.includes(key)) continue;
    // Match: "key" (case-insensitive), :, whitespace, "value" — replace the value only.
    const re = new RegExp(
      '("' + escapeRe(key) + '"\\s*:\\s*)"[^"]*"',
      "i"
    );
    if (re.test(line)) {
      return line.replace(re, '$1"********"');
    }
  }
  return line;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { redactServiceKeyLine };
