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
  // Match each <md:AssertionConsumerService …> element, then pull Binding +
  // Location out of it independently — XML does not guarantee attribute order,
  // and SAP's metadata has been seen with either order across landscapes.
  const acsRe = /<md:AssertionConsumerService\b[^>]*>/g;
  let ssoUrl = null;
  let m;
  while ((m = acsRe.exec(text)) !== null) {
    const tag = m[0];
    if (!/\bBinding="[^"]*HTTP-POST"/.test(tag)) continue;
    const loc = tag.match(/\bLocation="([^"]+)"/);
    if (loc) { ssoUrl = loc[1]; break; }
  }
  const alias = ssoUrl && ssoUrl.includes("/alias/")
    ? (ssoUrl.split("/alias/")[1] || null)
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

// Cockpit deep-link to a CF space's Applications page. All four GUIDs are
// required; returns null if any is missing so callers can hide the link rather
// than emit a broken URL. licenseType selects the trial vs productive cockpit
// base (see cockpitBaseFromLicense). GUIDs are [0-9a-f-] only, so no encoding
// is needed — matching trustConfigUrl.
function cockpitSpaceUrl({ licenseType, gaGuid, subGuid, orgGuid, spaceGuid }) {
  if (!gaGuid || !subGuid || !orgGuid || !spaceGuid) return null;
  const base = cockpitBaseFromLicense(licenseType);
  return `${base}#/globalaccount/${gaGuid}/subaccount/${subGuid}/org/${orgGuid}/space/${spaceGuid}/applications`;
}

// Derive the regional XSUAA/IAS *authentication* host segment from a CF
// landscape label. "cf-us10-001" → "us10"; a bare region passes through; empty
// → null. The CF landscape label carries a per-cluster discriminator (-001,
// -004) that the authentication host does NOT — so we drop a trailing
// digit-only group. Alphabetic suffixes (e.g. "cf-eu10-canary") are part of the
// region's identity-zone name and are preserved. NOTE: this stripped form is
// for the auth host ONLY — the CF API host keeps the suffix (api.cf.us10-001…).
function regionFromLandscape(landscape) {
  if (!landscape) return null;
  return String(landscape)
    .replace(/^cf-/, "")     // drop CF prefix
    .replace(/-\d+$/, "");   // drop trailing CF-cluster discriminator (-001, -004…)
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

// From `btp list security/available-idp` output, pick the SAP Cloud Identity
// Services tenant value to pass to `btp create security/trust --idp`. After the
// onboarding subscription completes, the provisioned tenant shows up in this
// list; its tenant value is what the trust command consumes (per the
// available-idp help text). The exact field name isn't documented, so we probe
// the likely identifier fields in priority order and prefer a value that looks
// like an IAS host (…accounts[N].ondemand.com or …cloud.sap). The chosen value
// is returned VERBATIM — the trust command wants the tenant identifier exactly
// as listed, not a normalized host. Accepts a bare array or a { value: [...] } /
// { identityProviders: [...] } wrapper. Returns null when no candidate exists.
function pickIasTenant(idpJson) {
  const list = Array.isArray(idpJson)
    ? idpJson
    : (idpJson && Array.isArray(idpJson.value)
        ? idpJson.value
        : (idpJson && Array.isArray(idpJson.identityProviders)
            ? idpJson.identityProviders
            : []));
  const FIELDS = ["name", "idpId", "id", "host", "tenant", "tenantName", "url", "idpUrl", "displayName"];
  const valuesOf = (e) =>
    (e && typeof e === "object")
      ? FIELDS.map((f) => e[f]).filter((v) => typeof v === "string" && v.trim())
      : [];
  const looksIas = (v) => /accounts\d*\.ondemand\.com|\.cloud\.sap/i.test(v);

  // First pass: an entry with a value that looks like an IAS host.
  for (const e of list) {
    const hit = valuesOf(e).find(looksIas);
    if (hit) return hit.trim();
  }
  // Fallback: the first identifier-ish field of the first entry.
  for (const e of list) {
    const v = valuesOf(e)[0];
    if (v) return v.trim();
  }
  return null;
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
  cockpitSpaceUrl,
  regionFromLandscape,
  findTrustOrigin,
  pickIasTenant,
  classifyAssignResult,
};
