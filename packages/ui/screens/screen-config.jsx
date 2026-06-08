/* global React, Ico, WizardFooter, ScrollReveal */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

function DockerVersionCombo({ value, onChange, tags }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative", display: "flex" }}>
      <input
        className="input is-mono"
        style={{ flex: 1, borderRadius: "6px 0 0 6px", borderRight: "none" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="2403-btp"
        onFocus={() => tags.length && setOpen(true)}
      />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          flexShrink: 0,
          width: 32,
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderLeft: "none",
          borderRadius: "0 6px 6px 0",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink-3)",
        }}
        tabIndex={-1}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5l3 3 3-3"/>
        </svg>
      </button>
      {open && tags.length > 0 && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 2px)",
          left: 0,
          right: 0,
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: 6,
          zIndex: 200,
          boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
          overflow: "hidden",
        }}>
          {tags.map((tag) => (
            <div
              key={tag}
              onMouseDown={() => { onChange(tag); setOpen(false); }}
              style={{
                padding: "7px 12px",
                cursor: "pointer",
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
                color: "var(--ink-0)",
                background: tag === value ? "var(--fg-blue-soft)" : "transparent",
              }}
              onMouseEnter={(e) => { if (tag !== value) e.currentTarget.style.background = "var(--surface-2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = tag === value ? "var(--fg-blue-soft)" : "transparent"; }}
            >
              {tag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 4. Deploy config
// ═══════════════════════════════════════════════════════════

// Field descriptors for the PostgreSQL parameters section. Trial mode shows
// only the limited pair the broker accepts; hyperscaler mode shows the
// commonly-tuned subset (storage, memory, retention, HA/access). The full
// schema (audit_log_level, maintenance_window, db_parameters, …) is written
// from orchestrator defaults — no UI affordance to keep "two-click deploy".
const PG_FIELDS_TRIAL = [
  { key: "engine_version", label: "Engine version", placeholder: "16", hint: "PostgreSQL major version." },
  { key: "locale",         label: "Locale",         placeholder: "en_US", hint: "Database locale." },
];
const PG_FIELDS_HYPERSCALER_COMMON = [
  { key: "engine_version",          label: "Engine version",            placeholder: "16",    hint: "PostgreSQL major version." },
  { key: "locale",                  label: "Locale",                    placeholder: "en_US", hint: "Database locale." },
  { key: "storage",                 label: "Storage (GB)",              placeholder: "20",    hint: "Disk size in gigabytes.", type: "number" },
  { key: "memory",                  label: "Memory (GB)",               placeholder: "2",     hint: "Instance memory in gigabytes.", type: "number" },
  { key: "backup_retention_period", label: "Backup retention (days)",   placeholder: "14",    hint: "How long backups are kept.", type: "number" },
  { key: "public_access",           label: "Public access",             type: "boolean",      hint: "Expose the DB to the public internet." },
];
const PG_FIELD_MULTI_AZ           = { key: "multi_az",            label: "Multi-AZ",          type: "boolean", hint: "Replicate across availability zones (paid plans only)." };
const PG_FIELD_CROSS_REGION_BACKUP = { key: "cross_region_backup", label: "Cross-region backup", type: "boolean", hint: "Replicate backups to a second region (GCP only)." };

function pgFieldsFor(trial, provider) {
  if (trial) return PG_FIELDS_TRIAL;
  const p = (provider || "").toLowerCase();
  const fields = PG_FIELDS_HYPERSCALER_COMMON.slice();
  if (p.includes("google") || p.includes("gcp")) {
    fields.push(PG_FIELD_CROSS_REGION_BACKUP);
  } else {
    fields.push(PG_FIELD_MULTI_AZ);
  }
  return fields;
}

function defaultsFor(trial, provider) {
  if (trial) return { engine_version: "16", locale: "en_US" };
  const p = (provider || "").toLowerCase();
  if (p.includes("aws") || p.includes("amazon")) {
    return { engine_version: "16", locale: "en_US", storage: 20, memory: 2, backup_retention_period: 14, multi_az: false, public_access: false };
  }
  if (p.includes("azure") || p.includes("microsoft")) {
    return { engine_version: "16", locale: "en_US", storage: 20, memory: 2, backup_retention_period: 14, multi_az: false, public_access: false };
  }
  if (p.includes("google") || p.includes("gcp")) {
    return { engine_version: "16", locale: "en_US", storage: 20, memory: 2, backup_retention_period: 7, public_access: false, cross_region_backup: true };
  }
  return { engine_version: "16", locale: "en_US" };
}

function ScreenConfig({ ctx, setCtx, onNext, onBack, appendLog }) {
  const cfg = ctx.config;
  const setCfg = (patch) => setCtx(c => ({ ...c, config: { ...c.config, ...patch } }));
  const setDbParam = (key, value) =>
    setCtx(c => ({ ...c, config: { ...c.config, dbParams: { ...(c.config.dbParams || {}), [key]: value } } }));
  const [domains, setDomains] = React.useState([]);
  const [plans, setPlans] = React.useState(ctx.dbPlans);
  const [dockerTags, setDockerTags] = React.useState([]);
  const [writing, setWriting] = React.useState(false);

  // Trial autodetection: the global account subdomain contains "trial" for
  // trial tenants (e.g. "12345trial-ga"). Seed lazily on mount so user
  // overrides of trialPg survive a re-render. Real-tenant override is the
  // checkbox at the top of the PG section.
  React.useEffect(() => {
    if (cfg.trialPg !== undefined) return;
    const sub = (ctx.login && ctx.login.subdomain) || "";
    const trial = /trial/i.test(sub);
    setCfg({ trialPg: trial });
    // eslint-disable-next-line
  }, [ctx.login && ctx.login.subdomain]);

  const trialPg = cfg.trialPg === true;
  const provider = (ctx.login && ctx.login.provider) || "";
  const pgFields = pgFieldsFor(trialPg, provider);
  const pgDefaults = defaultsFor(trialPg, provider);
  const dbParams = cfg.dbParams || {};
  const providerKnown = trialPg || !!provider;

  const valid = cfg.id && cfg.domain && cfg.dbPlan && cfg.dockerVersion && providerKnown;

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    (async () => {
      const landscape = ctx.login.landscape;

      const d = await api.cf.domains();
      let doms = d.ok ? d.domains : [];
      if (!doms.length && landscape) doms = [`cfapps.${landscape.replace(/^cf-/, '')}.hana.ondemand.com`];
      setDomains(doms);
      if (!cfg.domain && doms.length) setCfg({ domain: doms[0] });

      const tag = await api.config.dockerHubLatestBtpTag();
      if (tag.ok) {
        setCfg({ dockerVersion: tag.tag });
      }

      const tags = await api.config.dockerHubBtpTags();
      if (tags.ok && tags.tags.length) {
        setDockerTags(tags.tags);
      }

      const mk = await api.cf.marketplacePostgresql();
      if (mk.ok && mk.plans.length) {
        const mapped = mk.plans.map((p) => ({ name: p.name, description: p.description, free: p.free, size: p.free ? "shared" : "—" }));
        setPlans(mapped);
        setCtx(c => ({ ...c, dbPlans: mapped }));
        if (!mapped.find(p => p.name === cfg.dbPlan)) setCfg({ dbPlan: mapped[0].name });
      }
    })();
    // eslint-disable-next-line
  }, []);

  async function handleNext() {
    const api = fg();
    if (!api) return onNext();
    setWriting(true);
    const r = await api.config.writeVars({
      id: cfg.id,
      domain: cfg.domain,
      locationId: cfg.locationId,
      dockerVersion: cfg.dockerVersion,
      instanceMemory: cfg.instanceMemory,
      maxRamPercentage: cfg.maxRamPercentage,
      logsTotalSizeCap: cfg.logsTotalSizeCap,
      enableInstanceMonitoring: cfg.enableInstanceMonitoring,
      useCloudConnectorForSmtpIntegration: cfg.useCloudConnectorForSmtpIntegration,
      cloudConnectorDestinationNameForSmtpIntegration: cfg.cloudConnectorDestinationNameForSmtpIntegration,
    });
    if (!r || !r.ok) { setWriting(false); return; }
    const r2 = await api.config.writeDbConfig({
      trial: trialPg,
      provider,
      fields: dbParams,
    });
    setWriting(false);
    if (r2 && r2.ok) onNext();
    else if (appendLog && r2 && r2.error) appendLog([{ type: "err", text: r2.error }]);
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Configuration</div>
          <h1 className="pane-title">Configure the deployment</h1>
          <p className="pane-desc">
            We'll write these values to <span className="kbd">vars.yml</span> and create the PostgreSQL service from the selected plan.
          </p>
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>General</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Application ID <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.id}
              onChange={(e) => setCfg({ id: e.target.value })}
              placeholder="figaf-tool"
            />
            <div className="field-hint">Route path — lowercase, no spaces.</div>
          </div>

          <div className="field">
            <label className="field-label">
              Location ID
            </label>
            <input
              className="input is-mono"
              value={cfg.locationId}
              onChange={(e) => setCfg({ locationId: e.target.value })}
              placeholder="location-1"
              maxLength={20}
            />
            <div className="field-hint">Must be configured properly for integration with PI system through a Cloud connection.</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 4 }}>
          <div className="field">
            <label className="field-label">
              Landscape apps domain <span className="field-required">*</span>
            </label>
            <select
              className="select is-mono"
              value={cfg.domain}
              onChange={(e) => setCfg({ domain: e.target.value })}
            >
              <option value="">Select a domain…</option>
              {domains.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <div className="field-hint">
              Detected from <span className="kbd">cf domains</span>.
            </div>
          </div>

          <div className="field">
            <label className="field-label">
              Docker image version <span className="field-required">*</span>
            </label>
            <DockerVersionCombo
              value={cfg.dockerVersion || ""}
              onChange={(v) => setCfg({ dockerVersion: v })}
              tags={dockerTags}
            />
            <div className="field-hint">Latest Figaf image tag from Docker Hub (auto-detected). Select from dropdown or enter manually.</div>
          </div>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>Application settings</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Instance memory <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.instanceMemory}
              onChange={(e) => setCfg({ instanceMemory: e.target.value })}
              placeholder="3700M"
            />
            <div className="field-hint">RAM allocated for the app. Possible units: K, M, G, k, m, g</div>
          </div>

          <div className="field">
            <label className="field-label">
              Max RAM percentage <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.maxRamPercentage}
              onChange={(e) => setCfg({ maxRamPercentage: e.target.value })}
              placeholder="50"
            />
            <div className="field-hint">Percentage of physical memory used as maximum heap size</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
          <div className="field">
            <label className="field-label">
              Logs total size cap <span className="field-required">*</span>
            </label>
            <input
              className="input is-mono"
              value={cfg.logsTotalSizeCap}
              onChange={(e) => setCfg({ logsTotalSizeCap: e.target.value })}
              placeholder="2GB"
            />
            <div className="field-hint">Max capacity of 'logs' folder</div>
          </div>

          <div className="field">
            <label className="field-label">
              Enable instance monitoring
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cfg.enableInstanceMonitoring === true}
                  onChange={(e) => setCfg({ enableInstanceMonitoring: e.target.checked })}
                  style={{ cursor: "pointer" }}
                />
                Enable Glowroot monitoring
              </label>
            </div>
            <div className="field-hint">Adds Glowroot agent for instance monitoring endpoint</div>
          </div>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 12px" }}>Cloud connector settings</div>

        <div className="field">
          <label className="field-label">
            Use cloud connector for SMTP integration
          </label>
          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="smtp-connector"
                value="false"
                checked={cfg.useCloudConnectorForSmtpIntegration === false}
                onChange={() => setCfg({ useCloudConnectorForSmtpIntegration: false })}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: 13 }}>No</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="smtp-connector"
                value="true"
                checked={cfg.useCloudConnectorForSmtpIntegration === true}
                onChange={() => setCfg({ useCloudConnectorForSmtpIntegration: true })}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: 13 }}>Yes</span>
            </label>
          </div>
          <div className="field-hint">Whether the application should use a cloud connector for SMTP integration</div>
        </div>

        {cfg.useCloudConnectorForSmtpIntegration && (
          <ScrollReveal>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Cloud connector destination name
            </label>
            <input
              className="input is-mono"
              value={cfg.cloudConnectorDestinationNameForSmtpIntegration}
              onChange={(e) => setCfg({ cloudConnectorDestinationNameForSmtpIntegration: e.target.value })}
              placeholder="smtp-destination"
            />
            <div className="field-hint">Name of destination configured in SAP BTP Destination service for local SMTP server</div>
          </div>
          </ScrollReveal>
        )}

        <div className="divider" />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>PostgreSQL service</div>
          <span className="pill gray">postgresql-db · from marketplace</span>
        </div>

        <div className="field">
          <label className="field-label">
            Service plan <span className="field-required">*</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {plans.map(p => (
              <button
                key={p.name}
                className={`choice ${cfg.dbPlan === p.name ? "selected" : ""}`}
                style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14 }}
                onClick={() => setCfg({ dbPlan: p.name })}
              >
                <div style={{ width: 30, height: 30, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Ico.Database style={{ width: 16, height: 16 }} />
                </div>
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                    {p.name}
                    {p.free && <span className="pill green">Free</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                    {p.description}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                  {p.size}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="divider" />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>PostgreSQL parameters</div>
          <span className="pill gray">
            {trialPg
              ? "trial schema · limited"
              : (provider ? `${provider} schema` : "select subaccount first")}
          </span>
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={trialPg}
              onChange={(e) => setCfg({ trialPg: e.target.checked })}
              style={{ cursor: "pointer" }}
            />
            <span><strong>Trial subaccount</strong> — write the limited <span className="kbd">db.json</span> schema</span>
          </label>
          <div className="field-hint" style={{ marginLeft: 24 }}>
            Trial subaccounts only accept <span className="kbd">engine_version</span> and <span className="kbd">locale</span>.
            Auto-detected from the global account subdomain
            {ctx.login && ctx.login.subdomain ? <> (<span className="kbd">{ctx.login.subdomain}</span>)</> : null}.
          </div>
        </div>

        {!trialPg && !provider && (
          <div style={{ padding: "10px 12px", borderRadius: 6, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", fontSize: 12, color: "var(--ink-2)", marginBottom: 12 }}>
            Provider (AWS / Azure / GCP) couldn't be detected from the subaccount region.
            Either tick "Trial subaccount" above, or go back to the sign-in step and pick a subaccount with a known landscape.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {pgFields.map((f) => {
            const current = dbParams[f.key];
            const def = pgDefaults[f.key];
            if (f.type === "boolean") {
              const checked = current === undefined ? !!def : current === true;
              return (
                <div key={f.key} className="field">
                  <label className="field-label">{f.label}</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setDbParam(f.key, e.target.checked)}
                        style={{ cursor: "pointer" }}
                      />
                      {f.hint}
                    </label>
                  </div>
                </div>
              );
            }
            const value = current === undefined ? (def == null ? "" : String(def)) : current;
            return (
              <div key={f.key} className="field">
                <label className="field-label">{f.label}</label>
                <input
                  className="input is-mono"
                  type={f.type === "number" ? "number" : "text"}
                  value={value}
                  onChange={(e) => setDbParam(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
                <div className="field-hint">{f.hint}</div>
              </div>
            );
          })}
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={handleNext}
        nextDisabled={!valid || writing}
        nextLabel={writing ? "Writing vars.yml…" : "Start deployment"}
      />
    </>
  );
}

Object.assign(window, { ScreenConfig });
