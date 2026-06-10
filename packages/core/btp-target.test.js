"use strict";
// Pure-logic tests for the `btp target --hierarchy true` parser. No CLI, no I/O.
// Run via `node --test packages/core/btp-target.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseGlobalAccountTree } = require("./btp-target");

const SAMPLE = [
  "Current target:",
  " Figaf ApS (global account, subdomain: figafaps-02)",
  "",
  "Choose global account, subaccount, or directory:",
  "   [1] 17b44102trial (global account)",
  "   [2]  └─ trial (subaccount)",
  "",
  "   [3] 9c492946trial (global account)",
  "   [4]  ├─ account2 (subaccount)",
  "   [5]  └─ trial (subaccount)",
  "",
  "   [6] Figaf ApS (global account)",
  "   [7]  ├─ demotest (subaccount)",
  "   [8]  └─ figafpartner (subaccount)",
  "",
  "   [9] Figaf ApS (global account)",
  "  [10]  ├─ demoprod (subaccount)",
  "  [11]  ├─ Freetier (subaccount)",
  "  [12]  └─ freetieraws (subaccount)",
  "Choose, or hit ENTER to stay in 'Figaf ApS' [6]> ",
].join("\n");

test("parses every global account in order", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  assert.equal(accounts.length, 4);
  assert.deepEqual(accounts.map((a) => a.index), [1, 3, 6, 9]);
  assert.deepEqual(accounts.map((a) => a.name), ["17b44102trial", "9c492946trial", "Figaf ApS", "Figaf ApS"]);
});

test("attaches subaccounts to their parent GA with tree chars stripped", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  const ga9 = accounts.find((a) => a.index === 9);
  assert.deepEqual(ga9.subaccounts.map((s) => s.index), [10, 11, 12]);
  assert.deepEqual(ga9.subaccounts.map((s) => s.name), ["demoprod", "Freetier", "freetieraws"]);
  const ga1 = accounts.find((a) => a.index === 1);
  assert.deepEqual(ga1.subaccounts, [{ index: 2, name: "trial" }]);
});

test("captures the current target index from the prompt", () => {
  assert.equal(parseGlobalAccountTree(SAMPLE).currentIndex, 6);
});

test("captures currentIndex even when the GA name contains an apostrophe", () => {
  const txt = "   [3] O'Brien Corp (global account)\nChoose, or hit ENTER to stay in 'O'Brien Corp' [3]> ";
  assert.equal(parseGlobalAccountTree(txt).currentIndex, 3);
});

test("handles parentheses inside a name", () => {
  const r = parseGlobalAccountTree("   [1] Acct (EU) (global account)\n   [2]  └─ Sub (dev) (subaccount)");
  assert.equal(r.accounts[0].name, "Acct (EU)");
  assert.equal(r.accounts[0].subaccounts[0].name, "Sub (dev)");
});

test("ignores the Current target / Now targeting summary lines", () => {
  const { accounts } = parseGlobalAccountTree(SAMPLE);
  // 'Figaf ApS (global account, subdomain: figafaps-02)' has no [N] and must not become an account.
  assert.ok(accounts.every((a) => Number.isInteger(a.index)));
  assert.equal(accounts.length, 4);
});

test("strips ANSI escapes before parsing", () => {
  const withAnsi = "\x1b[1m   [1] MyGA (global account)\x1b[0m\nChoose, or hit ENTER to stay in 'MyGA' [1]> ";
  const { accounts, currentIndex } = parseGlobalAccountTree(withAnsi);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, "MyGA");
  assert.equal(currentIndex, 1);
});

test("returns empty accounts and null currentIndex on garbage", () => {
  const r = parseGlobalAccountTree("nothing useful here");
  assert.deepEqual(r.accounts, []);
  assert.equal(r.currentIndex, null);
});
