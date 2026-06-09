/* global React, Ico, CheckRow, WizardFooter */

const fgci = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// Connect · 3c. SAP Cloud Identity Services (IAS)
// Two manual steps, each triggered by a button:
//   1. btp subscribe accounts/subaccount --to-app
//      sap-identity-services-onboarding --plan default
//      --parameters {"cloud_service":"PRODUCTIVE"}   (a SaaS subscription —
//      NOT a cf service instance)
//   2. btp create security/trust --idp <tenant> --subaccount <sub>
//      (tenant resolved from `btp list security/available-idp`)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpIas({ ctx, setCtx, onNext, onBack }) {
  const [step1Status, setStep1Status] = React.useState("idle");
  const [step1Sub,    setStep1Sub]    = React.useState(null);
  const [step2Status, setStep2Status] = React.useState("idle");
  const [step2Sub,    setStep2Sub]    = React.useState(null);

  // iasUrl is persisted in ctx so navigating away and back restores completion.
  const iasUrl = ctx.connect.iasUrl;

  // Effective statuses account for the "already done in a prior session" case.
  const eff1 = iasUrl ? "done" : step1Status;
  const eff2 = iasUrl ? "done" : step2Status;

  const step1Done = eff1 === "done";
  const step2Done = eff2 === "done";

  async function runCreateIas() {
    const api = fgci();
    if (!api) return;
    setStep1Status("running");
    setStep1Sub("Subscribing to SAP Cloud Identity Services…");
    const r = await api.connect.createIasService();
    if (!r.ok) {
      setStep1Status("error");
      setStep1Sub(r.stderr || r.error || r.status || "Service creation failed");
      return;
    }
    setStep1Status("done");
    setStep1Sub(r.alreadyExists ? "Service already exists" : "Subscribed successfully");
  }

  async function runEstablishTrust() {
    const api = fgci();
    if (!api) return;
    setStep2Status("running");
    setStep2Sub("Reading service key + establishing BTP trust…");
    const r = await api.connect.establishIasTrust();
    if (!r.ok) {
      setStep2Status("error");
      setStep2Sub(r.stderr || r.error || "Trust establishment failed");
      return;
    }
    setCtx((c) => ({ ...c, connect: { ...c.connect, iasUrl: r.iasUrl } }));
    setStep2Status("done");
    setStep2Sub(r.alreadyExists ? "Trust already established" : "Trust established successfully");
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP Cloud Identity Services</div>
          <h1 className="pane-title">Set up SAP Cloud Identity Services</h1>
          <p className="pane-desc">
            The wizard will subscribe to an IAS tenant in this Cloud Foundry space,
            then establish a trust relationship between your subaccount and that
            tenant — giving Figaf a stable, SSO-aligned identity provider.
          </p>
        </div>

        {/* ── Step 1: create the CF service instance ─────────────────── */}
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                1. Subscribe to SAP Cloud Identity Services
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Subscribes this subaccount to app{" "}
                <span className="kbd">sap-identity-services-onboarding</span>
                {" · plan "}<span className="kbd">default</span>
                {" · params "}<span className="kbd">{`{"cloud_service":"PRODUCTIVE"}`}</span>
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={runCreateIas}
              disabled={eff1 === "running" || eff1 === "done"}
              style={{ marginLeft: 12, flexShrink: 0 }}
            >
              {eff1 === "running" ? <><Ico.Spinner /> Subscribing…</> : "Subscribe"}
            </button>
          </div>
          {eff1 !== "idle" && (
            <div style={{ marginTop: 12 }}>
              <CheckRow
                status={eff1}
                title="SAP Cloud Identity Services tenant"
                sub={step1Sub || (iasUrl ? "Already completed" : null)}
              />
            </div>
          )}
        </div>

        {/* ── Step 2: establish BTP trust ─────────────────────────────── */}
        <div
          className="card"
          style={{ padding: 16, marginBottom: 14, opacity: step1Done ? 1 : 0.5 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                2. Establish trust
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Looks up the provisioned IAS tenant in{" "}
                <span className="kbd">available-idp</span>, then runs{" "}
                <span className="kbd">btp create security/trust</span> for this subaccount.
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={runEstablishTrust}
              disabled={!step1Done || eff2 === "running" || eff2 === "done"}
              style={{ marginLeft: 12, flexShrink: 0 }}
            >
              {eff2 === "running" ? <><Ico.Spinner /> Establishing…</> : "Establish trust"}
            </button>
          </div>
          {eff2 !== "idle" && (
            <div style={{ marginTop: 12 }}>
              <CheckRow
                status={eff2}
                title="BTP trust configuration"
                sub={step2Sub || (iasUrl ? "Already completed" : null)}
              />
            </div>
          )}
          {(step2Done && iasUrl) && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }}>
              IAS tenant: <span className="kbd">{iasUrl}</span>
            </div>
          )}
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!(step1Done && step2Done)}
        nextLabel={step1Done && step2Done ? "Continue to finish" : "Complete both steps first"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpIas });
