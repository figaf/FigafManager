/* global React, Ico, WizardFooter */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// 4. Deploy config
// ═══════════════════════════════════════════════════════════
function ScreenConfig({ ctx, setCtx, onNext, onBack, appendLog }) {
  const cfg = ctx.config;
  const setCfg = (patch) => setCtx(c => ({ ...c, config: { ...c.config, ...patch } }));
  const [domains, setDomains] = React.useState([]);
  const [plans, setPlans] = React.useState(ctx.dbPlans);
  const [dockerTags, setDockerTags] = React.useState([]);
  const [writing, setWriting] = React.useState(false);

  const valid = cfg.id && cfg.domain && cfg.dbPlan && cfg.dockerVersion;

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
    setWriting(false);
    if (r && r.ok) onNext();
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
            <input
              list="dockerVersionsList"
              className="select is-mono"
              value={cfg.dockerVersion || ""}
              onChange={(e) => setCfg({ dockerVersion: e.target.value })}
              placeholder="2403-btp"
            />
            <datalist id="dockerVersionsList">
              {dockerTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
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
