"use strict";
// Pure logic for the custom-IDP connect flow. NO CLI, NO network, NO fs —
// every function here is deterministic and unit-tested in saml-connect.test.js.
// The orchestrator handlers call these; keeping them pure is what lets us test
// the tricky parsing/derivation without spawning btp or hitting the network.

// Extract the Figaf Tool's SSO endpoint from the subaccount's SAML SP metadata.
// We want the AssertionConsumerService with the HTTP-POST binding — its
// Location is the SSO URL (and embeds the landscape-specific `.aws-live` alias
// that no btp CLI command exposes). Returns { ssoUrl, alias } with nulls if the
// metadata can't be parsed.
function parseSsoUrlFromMetadata(xml) {
  const text = typeof xml === "string" ? xml : "";
  const m = text.match(
    /<md:AssertionConsumerService[^>]*Binding="[^"]*HTTP-POST"[^>]*Location="([^"]+)"/
  );
  const ssoUrl = m ? m[1] : null;
  const alias = ssoUrl && ssoUrl.includes("/alias/")
    ? ssoUrl.split("/alias/")[1]
    : null;
  return { ssoUrl, alias };
}

// Trial vs productive cockpit base. licenseType comes from
// `btp get accounts/global-account` (field `licenseType`). "TRIAL" is the
// authoritative trial signal — never sniff the subdomain.
function cockpitBaseFromLicense(licenseType) {
  return licenseType === "TRIAL"
    ? "https://cockpit.hanatrial.ondemand.com/trial/"
    : "https://cockpit.btp.cloud.sap/cockpit/";
}

// Cockpit deep-link to the subaccount's Trust Configuration screen. The
// fragment uses GUIDs (not subdomains) for both global account and subaccount.
function trustConfigUrl({ licenseType, gaGuid, subGuid }) {
  const base = cockpitBaseFromLicense(licenseType);
  return `${base}#/globalaccount/${gaGuid}/subaccount/${subGuid}/trustConfiguration`;
}

// "cf-us10" → "us10"; a bare region passes through; empty → null.
function regionFromLandscape(landscape) {
  if (!landscape) return null;
  return String(landscape).replace(/^cf-/, "");
}

// Find the trust config whose `name` matches idpName and return its originKey.
// Accepts either a bare array or a { value: [...] } wrapper (btp --format json
// returns the wrapper for some objects). `all` is always the [{name,originKey}]
// list so the UI can render a helpful "not found, here's what exists" message.
function findTrustOrigin(trustJson, idpName) {
  const list = Array.isArray(trustJson)
    ? trustJson
    : (trustJson && Array.isArray(trustJson.value) ? trustJson.value : []);
  const all = list.map((e) => ({ name: e.name, originKey: e.originKey }));
  const hit = list.find((e) => e.name === idpName);
  return {
    ok: !!hit,
    originKey: hit ? hit.originKey : null,
    all,
  };
}

// Interpret a `btp assign security/role-collection` result. Exit 0 (including
// a re-assignment that prints "already assigned") is success. "Unknown session"
// is a distinct, recoverable auth-expiry case the UI hints at specially.
function classifyAssignResult({ code, stdout, stderr }) {
  const blob = `${stdout || ""}\n${stderr || ""}`;
  const sessionExpired = /Unknown session/i.test(blob);
  const alreadyAssigned = /already assigned/i.test(blob);
  const tail = (stderr || stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join(" / ");
  return {
    ok: code === 0,
    alreadyAssigned,
    sessionExpired,
    stderr: tail,
  };
}

module.exports = {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  regionFromLandscape,
  findTrustOrigin,
  classifyAssignResult,
};
