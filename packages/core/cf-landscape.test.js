"use strict";
// Pure-logic tests for the CF API URL -> landscape parser.
// Run via `node --test packages/core/cf-landscape.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { landscapeFromApiUrl } = require("./cf-landscape");

test("extracts the landscape from a standard API URL", () => {
  assert.equal(landscapeFromApiUrl("https://api.cf.us10.hana.ondemand.com"), "cf.us10");
});

test("preserves the numeric suffix on extended landscape labels", () => {
  assert.equal(landscapeFromApiUrl("https://api.cf.us10-001.hana.ondemand.com"), "cf.us10-001");
});

test("is tolerant of uppercase host and a trailing slash", () => {
  assert.equal(landscapeFromApiUrl("HTTPS://API.CF.US10.HANA.ONDEMAND.COM/"), "cf.us10");
});

test("accepts an API URL without a scheme", () => {
  assert.equal(landscapeFromApiUrl("api.cf.eu10.hana.ondemand.com"), "cf.eu10");
});

test("ignores any path on the URL", () => {
  assert.equal(landscapeFromApiUrl("https://api.cf.ap21.hana.ondemand.com/v3/info"), "cf.ap21");
});

test("returns empty string for a custom / non-standard host", () => {
  assert.equal(landscapeFromApiUrl("https://cf.mycorp.example.com"), "");
});

test("returns empty string for empty / null / garbage input", () => {
  assert.equal(landscapeFromApiUrl(""), "");
  assert.equal(landscapeFromApiUrl(null), "");
  assert.equal(landscapeFromApiUrl(undefined), "");
  assert.equal(landscapeFromApiUrl("nonsense"), "");
});
