/* global React, Ico, CheckRow, WizardFooter, ScrollReveal */

const fgcp = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// Connect · 1. Provision it-rt services + read service keys
// ═══════════════════════════════════════════════════════════
function ScreenConnectProvision({ ctx, setCtx, onNext, onBack }) {
  const tasks = ctx.connect.tasks;
  const allDone = tasks.every((t) => t.status === "done");
  const keys = ctx.connect.keys;
  const marketplaceOk = ctx.connect.marketplaceOk;
  const [started, setStarted] = React.useState(false);

  const mark = React.useCallback(
    (id, patch) =>
      setCtx((c) => ({
        ...c,
        connect: {
          ...c.connect,
          tasks: c.connect.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        },
      })),
    [setCtx]
  );

  const setKey = React.useCallback(
    (which, payload) =>
      setCtx((c) => ({
        ...c,
        connect: { ...c.connect, keys: { ...c.connect.keys, [which]: payload } },
      })),
    [setCtx]
  );

  // Clear keys when the operator backs out (so credentials don't linger in ctx).
  const handleBack = () => {
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, keys: { api: null, iflow: null } },
    }));
    onBack && onBack();
  };

  async function runFlow() {
    const api = fgcp();
    if (!api) return;
    setStarted(true);

    // Pre-flight: probe it-rt entitlement.
    const mk = await api.cf.marketplaceCheck({ offering: "it-rt" });
    if (!mk.ok) {
      setCtx((c) => ({ ...c, connect: { ...c.connect, marketplaceOk: false } }));
      return;
    }
    setCtx((c) => ({ ...c, connect: { ...c.connect, marketplaceOk: true } }));

    const apiTplP   = await api.connect.templatePath("figaf-api.json");
    const iflowTplP = await api.connect.templatePath("figaf-iflow.json");
    if (!apiTplP.ok || !iflowTplP.ok) {
      mark("create-api", { status: "error", sub: "missing connect template" });
      mark("create-iflow", { status: "error", sub: "missing connect template" });
      return;
    }

    // Create both services in parallel; chain each key creation off its
    // service's success so we don't try create-service-key against an
    // unprovisioned service.
    const apiChain = (async () => {
      mark("create-api", { status: "running" });
      const r1 = await api.cf.createService({
        offering: "it-rt", plan: "api", name: "figaf-api", configFile: apiTplP.path,
      });
      if (!r1.ok) { mark("create-api", { status: "error", sub: r1.stderr || "create-service failed" }); return; }
      mark("create-api", { status: "done", sub: r1.alreadyExists ? "already exists" : "created" });

      mark("key-api", { status: "running" });
      const r2 = await api.cf.createServiceKey({ service: "figaf-api", key: "key-api" });
      if (!r2.ok) { mark("key-api", { status: "error", sub: r2.stderr || "create-service-key failed" }); return; }
      const r3 = await api.cf.serviceKey({ service: "figaf-api", key: "key-api" });
      if (!r3.ok) { mark("key-api", { status: "error", sub: r3.error || r3.stderr || "service-key read failed" }); return; }
      setKey("api", { json: r3.json, raw: r3.raw });
      mark("key-api", { status: "done", sub: r2.alreadyExists ? "key already existed; refreshed" : "key created + fetched" });
    })();

    const iflowChain = (async () => {
      mark("create-iflow", { status: "running" });
      const r1 = await api.cf.createService({
        offering: "it-rt", plan: "integration-flow", name: "figaf-iflow", configFile: iflowTplP.path,
      });
      if (!r1.ok) { mark("create-iflow", { status: "error", sub: r1.stderr || "create-service failed" }); return; }
      mark("create-iflow", { status: "done", sub: r1.alreadyExists ? "already exists" : "created" });

      mark("key-iflow", { status: "running" });
      const r2 = await api.cf.createServiceKey({ service: "figaf-iflow", key: "key-iflow" });
      if (!r2.ok) { mark("key-iflow", { status: "error", sub: r2.stderr || "create-service-key failed" }); return; }
      const r3 = await api.cf.serviceKey({ service: "figaf-iflow", key: "key-iflow" });
      if (!r3.ok) { mark("key-iflow", { status: "error", sub: r3.error || r3.stderr || "service-key read failed" }); return; }
      setKey("iflow", { json: r3.json, raw: r3.raw });
      mark("key-iflow", { status: "done", sub: r2.alreadyExists ? "key already existed; refreshed" : "key created + fetched" });
    })();

    await Promise.all([apiChain, iflowChain]);
  }

  React.useEffect(() => {
    if (!started) runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retryProbe() {
    // Reset task rows + marketplaceOk and re-run.
    setCtx((c) => ({
      ...c,
      connect: {
        ...c.connect,
        marketplaceOk: null,
        tasks: c.connect.tasks.map((t) => ({ ...t, status: "pending", sub: t.sub })),
        keys: { api: null, iflow: null },
      },
    }));
    setStarted(false);
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Provision</div>
          <h1 className="pane-title">
            {marketplaceOk === false ? "Integration Suite not entitled"
              : allDone ? "Service keys ready"
              : "Creating Integration Suite services…"}
          </h1>
          <p className="pane-desc">
            {marketplaceOk === false ? (
              <>
                The <span className="kbd">it-rt</span> service offering is not
                available in this subaccount. Subscribe to Integration Suite
                first, then retry.
              </>
            ) : allDone ? (
              <>Copy each key block into the matching field in the Figaf Tool.</>
            ) : (
              <>Provisioning <span className="kbd">figaf-api</span> and <span className="kbd">figaf-iflow</span> in <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span>.</>
            )}
          </p>
        </div>

        <IntegrationSuiteBanner />

        {marketplaceOk === false ? (
          <div className="card" style={{ padding: 18 }}>
            <p style={{ marginTop: 0 }}>
              Open the SAP cockpit and subscribe the <strong>Integration Suite</strong>
              tenant to this subaccount, then click Retry.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={retryProbe}>
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: "4px 18px" }}>
              <div className="checklist">
                {tasks.map((t) => <CheckRow key={t.id} {...t} />)}
              </div>
            </div>

            {allDone && (
              <ScrollReveal>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
                  <KeyCard label="API key (figaf-api / key-api)" keyData={keys.api} />
                  <KeyCard label="iFlow key (figaf-iflow / key-iflow)" keyData={keys.iflow} />
                </div>
              </ScrollReveal>
            )}
          </>
        )}
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={onNext}
        nextDisabled={!allDone || marketplaceOk === false}
        nextLabel={allDone ? "Continue to BTP access" : "Provisioning…"}
      />
    </>
  );
}

function KeyCard({ label, keyData }) {
  const [copied, setCopied] = React.useState(false);
  if (!keyData) return null;
  const displayJson = keyData.json?.credentials ?? keyData.json;
  const text = JSON.stringify(displayJson, null, 2);
  async function copy() {
    const api = fgcp();
    if (!api) return;
    try {
      await api.shell.writeClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <button className="btn" onClick={copy}>
          <Ico.Copy /> {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0, maxHeight: 260, overflow: "auto",
        background: "var(--surface-2)", padding: 10, borderRadius: 6,
        fontSize: 11, lineHeight: 1.4,
      }}>
{text}
      </pre>
    </div>
  );
}

// Banner shown at the top of the Provision screen: the Integration Suite
// subscription URL for the targeted subaccount (read once on mount via
// connect:integrationSuiteUrl). Renders nothing while loading or when the
// account has no IS subscription.
function IntegrationSuiteBanner() {
  const [url, setUrl] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      const api = fgcp();
      if (!api || !api.connect || !api.connect.integrationSuiteUrl) return;
      try {
        const r = await api.connect.integrationSuiteUrl();
        if (alive && r && r.ok && r.url) setUrl(r.url);
      } catch {
        /* non-fatal — the banner just stays hidden */
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!url) return null;

  async function copy() {
    const api = fgcp();
    if (!api) return;
    try {
      await api.shell.writeClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Integration Suite found on this account
          </div>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-2)",
            wordBreak: "break-all", background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px",
          }}>
            {url}
          </div>
        </div>
        <button className="btn" onClick={copy} style={{ flexShrink: 0 }}>
          <Ico.Copy /> {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenConnectProvision });
