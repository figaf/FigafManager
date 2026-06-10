"use strict";
// Pure parser for `btp target --hierarchy true` output. No CLI, no I/O.
// The tree lists every reachable global account (GA) and its subaccounts with
// globally-sequential [N] indices; GA navigation is by index — the only thing
// that disambiguates same-named GAs (e.g. two "Figaf ApS"). See
// docs/superpowers/specs/2026-06-10-btp-login-global-account-picker-design.md

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// A tree row: optional indent, [N], optional box-drawing prefix, name, "(type)".
const ROW_RE = /^\s*\[(\d+)\]\s+(.*?)\s+\((global account|subaccount|directory)\)\s*$/;
// The trailing prompt reveals the current target's index: "... [6]>".
const CURRENT_RE = /hit ENTER to stay in '[^']*'\s*\[(\d+)\]/;

function cleanText(raw) {
  return String(raw || "").replace(ANSI_RE, "").replace(/\r/g, "");
}

// Remove leading box-drawing chars (│ ├ └ ─) and whitespace from a subaccount name.
function stripTreeChars(s) {
  return s.replace(/^[\s│├└─]+/, "").trim();
}

// Parse raw `btp target --hierarchy true` stdout.
// Returns { accounts: [{ index, name, subaccounts: [{ index, name }] }], currentIndex }.
function parseGlobalAccountTree(raw) {
  const text = cleanText(raw);
  const accounts = [];
  let current = null;
  let currentIndex = null;

  for (const line of text.split("\n")) {
    const cm = CURRENT_RE.exec(line);
    if (cm) currentIndex = Number(cm[1]);

    const m = ROW_RE.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    const type = m[3];
    if (type === "global account") {
      current = { index, name: m[2].trim(), subaccounts: [] };
      accounts.push(current);
    } else if (type === "subaccount") {
      if (current) current.subaccounts.push({ index, name: stripTreeChars(m[2]) });
    }
    // "directory" rows are intentionally ignored.
  }
  return { accounts, currentIndex };
}

module.exports = { parseGlobalAccountTree, cleanText };
