"use strict";

// PostgreSQL service parameter schemas for SAP BTP postgresql-db.
// Reference: https://help.sap.com/docs/postgresql-on-sap-btp/postgresql-on-sap-btp-hyperscaler-option/parameters
//
// The orchestrator owns the schema map — the renderer sends a small structured
// payload {trial, provider, fields} and we assemble the JSON written to
// <deployDir>/db.json. Keeping all SAP-side schema knowledge in one file means
// future SAP changes are a one-file edit.

// Figaf Tool depends on these extensions at runtime (uuid-ossp/pgcrypto/pg_trgm/etc).
// Always included on hyperscaler plans; stripped on trial because the broker
// rejects extra keys outside the limited schema.
const POSTGRESQL_EXTENSIONS = [
  "ltree",
  "citext",
  "pg_stat_statements",
  "pgcrypto",
  "fuzzystrmatch",
  "hstore",
  "btree_gist",
  "btree_gin",
  "pg_trgm",
  "uuid-ossp",
];

// Provider key normalization — accepts the providerFromRegion() output values
// ("AWS", "Microsoft Azure", "Google Cloud Platform") plus shorthand forms.
function normalizeProvider(p) {
  if (!p) return null;
  const s = String(p).toLowerCase();
  if (s.includes("aws") || s === "amazon") return "aws";
  if (s.includes("azure") || s.includes("microsoft")) return "azure";
  if (s.includes("gcp") || s.includes("google")) return "gcp";
  return null;
}

// Defaults the wizard writes when the operator doesn't override them. These
// are the values rendered into db.json for the chosen hyperscaler.
function trialDefaults() {
  return {
    engine_version: "16",
    locale: "en_US",
  };
}

function awsDefaults() {
  return {
    allow_access: "",
    audit_log_level: ["ROLE", "DDL"],
    backup_retention_period: 14,
    db_parameters: [],
    engine_version: "16",
    ignore_default_ips: false,
    locale: "en_US",
    maintenance_window: { day_of_week: "Sunday", duration: 1, start_hour_utc: 4 },
    memory: 2,
    multi_az: false,
    public_access: false,
    storage: 20,
  };
}

function azureDefaults() {
  return {
    allow_access: "",
    audit_log_level: ["ROLE", "DDL"],
    backup_retention_period: 14,
    db_parameters: [],
    engine_version: "16",
    locale: "en_US",
    maintenance_window: { day_of_week: "Sunday", start_hour_utc: 4, start_minute_utc: 0 },
    memory: 2,
    multi_az: false,
    public_access: false,
    storage: 20,
  };
}

function gcpDefaults() {
  return {
    allow_access: "",
    backup_retention_period: 7,
    cross_region_backup: true,
    db_parameters: [],
    engine_version: "16",
    locale: "en_US",
    maintenance_window: { day_of_week: "Sunday", start_hour_utc: 4 },
    memory: 2,
    multi_az: false,
    public_access: false,
    storage: 20,
  };
}

// Which fields the UI is allowed to override per mode. Anything outside this
// allow-list is taken from the defaults map and never touched by the renderer.
const TRIAL_FIELDS = ["engine_version", "locale"];
const HYPERSCALER_FIELDS = [
  "engine_version",
  "locale",
  "storage",
  "memory",
  "backup_retention_period",
  "multi_az",        // ignored on GCP (not in schema)
  "public_access",
  "cross_region_backup", // GCP only
];

const NUMERIC_FIELDS = new Set(["storage", "memory", "backup_retention_period"]);
const BOOLEAN_FIELDS = new Set(["multi_az", "public_access", "cross_region_backup"]);

function defaultsFor(trial, provider) {
  if (trial) return trialDefaults();
  switch (normalizeProvider(provider)) {
    case "aws":   return awsDefaults();
    case "azure": return azureDefaults();
    case "gcp":   return gcpDefaults();
    default:      return null;
  }
}

function allowedFields(trial, provider) {
  if (trial) return TRIAL_FIELDS.slice();
  const p = normalizeProvider(provider);
  return HYPERSCALER_FIELDS.filter((f) => {
    if (f === "multi_az" && p === "gcp") return false;
    if (f === "cross_region_backup" && p !== "gcp") return false;
    return true;
  });
}

// Build the JSON to write to db.json. `fields` is the renderer's
// {key: stringValue} bag — values arrive as strings (form inputs) and we
// coerce to the right type per NUMERIC_FIELDS/BOOLEAN_FIELDS.
function buildDbConfig({ trial, provider, fields }) {
  const base = defaultsFor(trial, provider);
  if (!base) {
    return { ok: false, error: `Unknown provider "${provider}" (expected AWS, Azure, or GCP)` };
  }
  const allow = new Set(allowedFields(trial, provider));
  const out = { ...base };
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allow.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (NUMERIC_FIELDS.has(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    } else if (BOOLEAN_FIELDS.has(key)) {
      out[key] = value === true || value === "true";
    } else {
      out[key] = value;
    }
  }
  // Hyperscaler plans include the extension list; trial schema rejects it.
  if (!trial) out.postgresql_extensions = POSTGRESQL_EXTENSIONS.slice();
  return { ok: true, json: out };
}

module.exports = {
  POSTGRESQL_EXTENSIONS,
  TRIAL_FIELDS,
  HYPERSCALER_FIELDS,
  normalizeProvider,
  defaultsFor,
  allowedFields,
  buildDbConfig,
};
