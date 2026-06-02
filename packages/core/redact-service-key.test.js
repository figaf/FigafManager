"use strict";
// Tests for the per-line redaction helper used by the cf:serviceKey handler.
// Run via `node --test packages/core/redact-service-key.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redactServiceKeyLine } = require("./redact-service-key");

test("redacts clientsecret JSON value", () => {
  const line = '  "clientsecret": "QqWeRtYuIoP1234567890",';
  const out = redactServiceKeyLine(line);
  assert.equal(out, '  "clientsecret": "********",');
});

test("redacts client_secret (snake_case) JSON value", () => {
  const line = '  "client_secret": "abc-def-123",';
  assert.equal(redactServiceKeyLine(line), '  "client_secret": "********",');
});

test("redacts clientid JSON value", () => {
  const line = '  "clientid": "sb-figaf-api!t12345",';
  assert.equal(redactServiceKeyLine(line), '  "clientid": "********",');
});

test("redacts tokenurl JSON value", () => {
  const line = '  "tokenurl": "https://example.authentication.eu10.hana.ondemand.com/oauth/token",';
  assert.equal(redactServiceKeyLine(line), '  "tokenurl": "********",');
});

test("redacts password JSON value", () => {
  const line = '  "password": "hunter2",';
  assert.equal(redactServiceKeyLine(line), '  "password": "********",');
});

test("redacts a PEM-style BEGIN line entirely", () => {
  const line = "-----BEGIN PRIVATE KEY-----";
  assert.equal(redactServiceKeyLine(line), "********");
});

test("redacts a URL containing a clientsecret query parameter", () => {
  const line = "  Visit https://example.com/cb?clientsecret=SECRETVALUE&state=ok";
  const out = redactServiceKeyLine(line);
  // Whole line is replaced because the value is embedded in a URL we can't
  // safely segment with the simple "value-of-key" rule.
  assert.equal(out, "********");
});

test("non-sensitive line passes through unchanged", () => {
  const line = "Getting key key-api for service instance figaf-api as you@example.com...";
  assert.equal(redactServiceKeyLine(line), line);
});

test("a JSON brace line passes through unchanged", () => {
  assert.equal(redactServiceKeyLine("{"), "{");
  assert.equal(redactServiceKeyLine("}"), "}");
});

test("case-insensitive match on key name", () => {
  const line = '  "ClientSecret": "MixedCase",';
  assert.equal(redactServiceKeyLine(line), '  "ClientSecret": "********",');
});

test("preserves leading whitespace", () => {
  const line = '      "clientsecret": "x",';
  assert.equal(redactServiceKeyLine(line), '      "clientsecret": "********",');
});

test("non-string input passes through", () => {
  assert.equal(redactServiceKeyLine(null), null);
  assert.equal(redactServiceKeyLine(undefined), undefined);
});
