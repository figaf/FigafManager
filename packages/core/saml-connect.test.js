"use strict";
// Pure-logic tests for the custom-IDP connect flow. No CLI, no network.
// Run via `node --test packages/core/saml-connect.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  regionFromLandscape,
  findTrustOrigin,
  pickIasTenant,
  classifyAssignResult,
} = require("./saml-connect");

const SAMPLE_METADATA = `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://9c492946trial.authentication.us10.hana.ondemand.com">
  <md:SPSSODescriptor>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SingleLogout/alias/9c492946trial.aws-live"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SSO/alias/9c492946trial.aws-live" index="0" isDefault="true"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:URI" Location="https://9c492946trial.authentication.us10.hana.ondemand.com/oauth/token/alias/9c492946trial.aws-live" index="1"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

// ── parseSsoUrlFromMetadata ──────────────────────────────────────────────
test("parseSsoUrlFromMetadata extracts the HTTP-POST ACS Location", () => {
  const r = parseSsoUrlFromMetadata(SAMPLE_METADATA);
  assert.equal(r.ssoUrl, "https://9c492946trial.authentication.us10.hana.ondemand.com/saml/SSO/alias/9c492946trial.aws-live");
  assert.equal(r.alias, "9c492946trial.aws-live");
});

test("parseSsoUrlFromMetadata ignores the non-POST (URI) ACS binding", () => {
  const r = parseSsoUrlFromMetadata(SAMPLE_METADATA);
  assert.ok(!r.ssoUrl.includes("/oauth/token/"));
});

test("parseSsoUrlFromMetadata returns null ssoUrl on garbage input", () => {
  const r = parseSsoUrlFromMetadata("<nope/>");
  assert.equal(r.ssoUrl, null);
  assert.equal(r.alias, null);
});

// ── cockpitBaseFromLicense ───────────────────────────────────────────────
test("cockpitBaseFromLicense returns trial host for TRIAL", () => {
  assert.equal(cockpitBaseFromLicense("TRIAL"), "https://cockpit.hanatrial.ondemand.com/trial/");
});

test("cockpitBaseFromLicense returns productive host otherwise", () => {
  assert.equal(cockpitBaseFromLicense("Subscription"), "https://cockpit.btp.cloud.sap/cockpit/");
  assert.equal(cockpitBaseFromLicense(null), "https://cockpit.btp.cloud.sap/cockpit/");
});

// ── trustConfigUrl ───────────────────────────────────────────────────────
test("trustConfigUrl builds the trial deep-link with GUIDs", () => {
  const url = trustConfigUrl({ licenseType: "TRIAL", gaGuid: "GA-1", subGuid: "SUB-2" });
  assert.equal(url, "https://cockpit.hanatrial.ondemand.com/trial/#/globalaccount/GA-1/subaccount/SUB-2/trustConfiguration");
});

test("trustConfigUrl builds the productive deep-link", () => {
  const url = trustConfigUrl({ licenseType: "Subscription", gaGuid: "GA-1", subGuid: "SUB-2" });
  assert.equal(url, "https://cockpit.btp.cloud.sap/cockpit/#/globalaccount/GA-1/subaccount/SUB-2/trustConfiguration");
});

// ── regionFromLandscape ──────────────────────────────────────────────────
test("regionFromLandscape strips the cf- prefix", () => {
  assert.equal(regionFromLandscape("cf-us10"), "us10");
  assert.equal(regionFromLandscape("cf-eu10"), "eu10");
});

test("regionFromLandscape strips the trailing -NNN CF-cluster discriminator", () => {
  // The CF landscape label carries a per-cluster suffix (-001, -004) that the
  // regional XSUAA/IAS *authentication* host does NOT. Drop it for the auth host.
  assert.equal(regionFromLandscape("cf-us10-001"), "us10");
  assert.equal(regionFromLandscape("cf-eu10-004"), "eu10");
});

test("regionFromLandscape preserves a trailing ALPHABETIC suffix (e.g. -canary)", () => {
  // Canary is part of the regional identity-zone name, not a cluster number —
  // it must survive. Only a trailing digit-only group is a cluster discriminator.
  assert.equal(regionFromLandscape("cf-eu10-canary"), "eu10-canary");
});

test("regionFromLandscape passes through a bare region", () => {
  assert.equal(regionFromLandscape("ap20"), "ap20");
  assert.equal(regionFromLandscape("ap21"), "ap21");
});

test("regionFromLandscape returns null on empty", () => {
  assert.equal(regionFromLandscape(""), null);
  assert.equal(regionFromLandscape(null), null);
});

// ── findTrustOrigin ──────────────────────────────────────────────────────
const TRUST_LIST = [
  { name: "sap.default", originKey: "sap.default", protocol: "OpenID Connect" },
  { name: "figaf-saml", originKey: "idp-5565d868", protocol: "SAML" },
];

test("findTrustOrigin matches by name and returns originKey + list", () => {
  const r = findTrustOrigin(TRUST_LIST, "figaf-saml");
  assert.equal(r.ok, true);
  assert.equal(r.originKey, "idp-5565d868");
  assert.deepEqual(r.all, [
    { name: "sap.default", originKey: "sap.default" },
    { name: "figaf-saml", originKey: "idp-5565d868" },
  ]);
});

test("findTrustOrigin reports not-found with the available names", () => {
  const r = findTrustOrigin(TRUST_LIST, "typo-idp");
  assert.equal(r.ok, false);
  assert.equal(r.originKey, null);
  assert.deepEqual(r.all.map((e) => e.name), ["sap.default", "figaf-saml"]);
});

test("findTrustOrigin handles a {value:[...]} wrapper and a bare array", () => {
  assert.equal(findTrustOrigin({ value: TRUST_LIST }, "figaf-saml").originKey, "idp-5565d868");
  assert.equal(findTrustOrigin(TRUST_LIST, "figaf-saml").originKey, "idp-5565d868");
});

test("findTrustOrigin is defensive against non-array input", () => {
  const r = findTrustOrigin(null, "figaf-saml");
  assert.equal(r.ok, false);
  assert.deepEqual(r.all, []);
});

// ── classifyAssignResult ─────────────────────────────────────────────────
test("classifyAssignResult: exit 0 is ok", () => {
  const r = classifyAssignResult({ code: 0, stdout: "✔ OK", stderr: "" });
  assert.equal(r.ok, true);
  assert.equal(r.sessionExpired, false);
});

test("classifyAssignResult: 'already assigned' on exit 0 is ok+alreadyAssigned", () => {
  const r = classifyAssignResult({ code: 0, stdout: "Role collection already assigned", stderr: "" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyAssigned, true);
});

test("classifyAssignResult: 'Unknown session' sets sessionExpired", () => {
  const r = classifyAssignResult({ code: 1, stdout: "", stderr: "Unknown session. Please log in." });
  assert.equal(r.ok, false);
  assert.equal(r.sessionExpired, true);
  assert.match(r.stderr, /Unknown session/);
});

test("classifyAssignResult: origin-key error surfaces stderr, not session", () => {
  const r = classifyAssignResult({ code: 1, stdout: "", stderr: "error: IDP cannot be found by origin_key: figaf-saml" });
  assert.equal(r.ok, false);
  assert.equal(r.sessionExpired, false);
  assert.match(r.stderr, /origin_key/);
});

test("parseSsoUrlFromMetadata works when Location precedes Binding (attr order)", () => {
  const reordered = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">
    <md:SPSSODescriptor>
      <md:AssertionConsumerService Location="https://x.authentication.us10.hana.ondemand.com/saml/SSO/alias/x.aws-live" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" index="0"/>
    </md:SPSSODescriptor>
  </md:EntityDescriptor>`;
  const r = parseSsoUrlFromMetadata(reordered);
  assert.equal(r.ssoUrl, "https://x.authentication.us10.hana.ondemand.com/saml/SSO/alias/x.aws-live");
  assert.equal(r.alias, "x.aws-live");
});

test("parseSsoUrlFromMetadata returns null alias when URL ends with /alias/", () => {
  const trailing = `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://x/saml/SSO/alias/"/>`;
  const r = parseSsoUrlFromMetadata(trailing);
  assert.equal(r.ssoUrl, "https://x/saml/SSO/alias/");
  assert.equal(r.alias, null);
});

test("parseSsoUrlFromMetadata returns null when only a URI-binding ACS exists", () => {
  const uriOnly = `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:URI" Location="https://x/oauth/token/alias/x.aws-live"/>`;
  const r = parseSsoUrlFromMetadata(uriOnly);
  assert.equal(r.ssoUrl, null);
  assert.equal(r.alias, null);
});

// ── pickIasTenant ────────────────────────────────────────────────────────
// NOTE: the exact field name in `btp list security/available-idp` entries is
// not documented (the list is empty until an IAS tenant is onboarded), so the
// helper probes likely identifier fields and prefers an IAS-host-looking value.
// These cases pin the resolution order against the field shapes we anticipate.
test("pickIasTenant prefers an IAS-host-looking value over other fields", () => {
  const idps = [{ id: "abc-123", name: "my-tenant.accounts.ondemand.com", displayName: "Corp IAS" }];
  assert.equal(pickIasTenant(idps), "my-tenant.accounts.ondemand.com");
});

test("pickIasTenant handles a {value:[...]} wrapper", () => {
  const idps = { value: [{ name: "t.accounts.ondemand.com" }] };
  assert.equal(pickIasTenant(idps), "t.accounts.ondemand.com");
});

test("pickIasTenant handles an {identityProviders:[...]} wrapper", () => {
  const idps = { identityProviders: [{ host: "t.accounts.ondemand.com" }] };
  assert.equal(pickIasTenant(idps), "t.accounts.ondemand.com");
});

test("pickIasTenant matches a cloud.sap IAS host", () => {
  assert.equal(pickIasTenant([{ name: "t.cloud.sap" }]), "t.cloud.sap");
});

test("pickIasTenant falls back to the first identifier field when none look like a host", () => {
  assert.equal(pickIasTenant([{ id: "tenant-guid-1", displayName: "Some IDP" }]), "tenant-guid-1");
});

test("pickIasTenant skips an entry with no identifier fields and uses the next", () => {
  const idps = [{ irrelevant: 42 }, { name: "t.accounts.ondemand.com" }];
  assert.equal(pickIasTenant(idps), "t.accounts.ondemand.com");
});

test("pickIasTenant returns null for empty / non-array / no-field input", () => {
  assert.equal(pickIasTenant([]), null);
  assert.equal(pickIasTenant(null), null);
  assert.equal(pickIasTenant([{ foo: 1 }]), null);
});

test("pickIasTenant trims surrounding whitespace", () => {
  assert.equal(pickIasTenant([{ name: "  t.accounts.ondemand.com  " }]), "t.accounts.ondemand.com");
});
