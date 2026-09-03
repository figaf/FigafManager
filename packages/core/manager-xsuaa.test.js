"use strict";
// Tests for manager-xsuaa.js (figaf-l3-l4 decision 0009: one XSUAA instance
// for the manager and the apps).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const mx = require("./manager-xsuaa");

const RELEASE = {
  xsappname: "figaf-l3l4",
  "tenant-mode": "dedicated",
  description: "apps",
  scopes: [
    { name: "$XSAPPNAME.FigafL3L4PlatformAccess", description: "baseline" },
    { name: "$XSAPPNAME.FigafL3L4B2BArchivingSetupAdmin", description: "app admin" },
  ],
  "role-templates": [
    { name: "FigafL3L4B2BArchivingSetupAdmin", "scope-references": ["$XSAPPNAME.FigafL3L4PlatformAccess", "$XSAPPNAME.FigafL3L4B2BArchivingSetupAdmin"] },
  ],
  "role-collections": [
    { name: "FigafL3L4-B2BArchivingSetup-Admin", "role-template-references": ["$XSAPPNAME.FigafL3L4B2BArchivingSetupAdmin"] },
  ],
  "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**"] },
};

test("xsappnameBase strips the tenant suffix of a binding", () => {
  assert.equal(mx.xsappnameBase("figaf-l3l4!t12345"), "figaf-l3l4");
  assert.equal(mx.xsappnameBase("figaf-l3l4"), "figaf-l3l4");
  assert.equal(mx.xsappnameBase(""), "");
  assert.equal(mx.xsappnameBase(null), "");
});

test("operatorScopeName: shared instance -> FigafL3L4ManagerOperator; legacy or unknown -> FigafManagerOperator", () => {
  assert.equal(mx.operatorScopeName("figaf-l3l4!t1"), "FigafL3L4ManagerOperator");
  assert.equal(mx.operatorScopeName("figaf-l3l4"), "FigafL3L4ManagerOperator");
  assert.equal(mx.operatorScopeName("figaf-manager-xsuaa!t1"), "FigafManagerOperator");
  assert.equal(mx.operatorScopeName("something-else"), "FigafManagerOperator");
  assert.equal(mx.operatorScopeName(undefined), "FigafManagerOperator");
});

test("adminCollectionFor: shared -> FigafL3L4-Manager-Admin, legacy -> FigafManagerAdmin", () => {
  assert.equal(mx.adminCollectionFor("figaf-l3l4-xsuaa"), "FigafL3L4-Manager-Admin");
  assert.equal(mx.adminCollectionFor("figaf-manager-xsuaa"), "FigafManagerAdmin");
});

test("composeXsSecurity: release + manager part = union by name, xsappname shared, placeholder filled, token validity from the manager part", () => {
  const r = mx.composeXsSecurity({ release: RELEASE, appsDomain: "cfapps.eu10-004.hana.ondemand.com" });
  assert.equal(r.ok, true, r.error);
  const d = r.doc;
  assert.equal(d.xsappname, "figaf-l3l4");
  assert.equal(d["tenant-mode"], "dedicated");
  const scopeNames = d.scopes.map((s) => s.name);
  assert.ok(scopeNames.includes("$XSAPPNAME.FigafL3L4PlatformAccess"));
  assert.ok(scopeNames.includes("$XSAPPNAME.FigafL3L4ManagerOperator"));
  assert.ok(scopeNames.includes("$XSAPPNAME.FigafL3L4ManagerAdmin"));
  // The release entries come first (the apps' order is kept).
  assert.equal(scopeNames[0], "$XSAPPNAME.FigafL3L4PlatformAccess");
  assert.deepEqual(
    d["role-collections"].map((c) => c.name),
    ["FigafL3L4-B2BArchivingSetup-Admin", "FigafL3L4-Manager-Operator", "FigafL3L4-Manager-Admin"],
  );
  assert.deepEqual(d["role-templates"].map((t) => t.name), ["FigafL3L4B2BArchivingSetupAdmin", "FigafL3L4ManagerOperator", "FigafL3L4ManagerAdmin"]);
  assert.deepEqual(d["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.eu10-004.hana.ondemand.com/**"]);
  assert.equal(d["oauth2-configuration"]["token-validity"], 3600);
  assert.equal(d["oauth2-configuration"]["refresh-token-validity"], 86400);
  assert.ok(!JSON.stringify(d).includes("__CF_APPS_DOMAIN__"));
});

test("composeXsSecurity: a name defined by both sides is taken from the release (the release wins)", () => {
  const release = { ...RELEASE, scopes: [...RELEASE.scopes, { name: "$XSAPPNAME.FigafL3L4ManagerOperator", description: "from the release" }] };
  const r = mx.composeXsSecurity({ release, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true);
  const op = r.doc.scopes.filter((s) => s.name === "$XSAPPNAME.FigafL3L4ManagerOperator");
  assert.equal(op.length, 1);
  assert.equal(op[0].description, "from the release");
});

test("composeXsSecurity: no release present -> the manager part alone, xsappname shared", () => {
  const r = mx.composeXsSecurity({ release: null, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.doc.xsappname, "figaf-l3l4");
  assert.deepEqual(r.doc["role-collections"].map((c) => c.name), ["FigafL3L4-Manager-Operator", "FigafL3L4-Manager-Admin"]);
  assert.deepEqual(r.doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.x/**"]);
});

test("composeXsSecurity: a release with another xsappname is refused (decision 0008)", () => {
  const r = mx.composeXsSecurity({ release: { ...RELEASE, xsappname: "figaf-l3l4-arch-playground" }, appsDomain: "cfapps.x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be 'figaf-l3l4'/);
});

test("composeXsSecurity: placeholder present but no domain -> clear error, nothing composed", () => {
  const r = mx.composeXsSecurity({ release: RELEASE });
  assert.equal(r.ok, false);
  assert.match(r.error, /cfapps domain/);
});

test("composeXsSecurity: extra top-level keys of the release pass through; redirect URIs are united without duplicates", () => {
  const release = {
    ...RELEASE,
    attributes: [{ name: "x", valueType: "string" }],
    "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**", "https://other.example/**"] },
  };
  const r = mx.composeXsSecurity({ release, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.attributes, [{ name: "x", valueType: "string" }]);
  assert.deepEqual(r.doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.x/**", "https://other.example/**"]);
});

test("the bundled manager part carries the frozen identifiers of decision 0009", () => {
  const p = mx.MANAGER_PART;
  assert.equal(p.xsappname, "figaf-l3l4");
  assert.deepEqual(p.scopes.map((s) => s.name), ["$XSAPPNAME.FigafL3L4ManagerOperator", "$XSAPPNAME.FigafL3L4ManagerAdmin"]);
  assert.deepEqual(p["role-collections"].map((c) => c.name), ["FigafL3L4-Manager-Operator", "FigafL3L4-Manager-Admin"]);
  const admin = p["role-templates"].find((t) => t.name === "FigafL3L4ManagerAdmin");
  assert.ok(admin["scope-references"].includes("$XSAPPNAME.FigafL3L4ManagerOperator"), "Admin includes Operator");
});
