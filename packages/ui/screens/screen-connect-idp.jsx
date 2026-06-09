/* global React, Ico, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 2. Pick BTP access mode
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdp({ ctx, setCtx, onNext, onBack }) {
  const sel = ctx.connect.idpMode;
  function pick(v) {
    setCtx((c) => ({ ...c, connect: { ...c.connect, idpMode: v } }));
  }

  const modes = [
    {
      id: "s-user",
      icon: <Ico.User />,
      title: "S-User",
      desc: "Communication user; the simplest fit for shared deployments and most SAP customers.",
    },
    {
      id: "sap-passport",
      icon: <Ico.Shield />,
      title: "SAP Passport",
      desc: "Certificate-based authentication for SAP-managed cloud customers.",
    },
    {
      id: "ias",
      icon: <Ico.Cloud />,
      title: "SAP User Identity Service",
      desc: "Federate through your IAS tenant — single sign-on for the same users as the cockpit.",
    },
    {
      id: "custom-idp",
      icon: <Ico.Link />,
      title: "Custom IDP",
      desc: "Bring your own SAML/OIDC identity provider.",
    },
  ];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · BTP access</div>
          <h1 className="pane-title">How should Figaf authenticate against BTP?</h1>
          <p className="pane-desc">
            Pick the identity model that matches your subaccount. Each path
            will run a separate, mode-specific configuration step.
          </p>
        </div>

        <div className="choice-grid">
          {modes.map((m) => (
            <button
              key={m.id}
              className={`choice ${sel === m.id ? "selected" : ""}`}
              onClick={() => pick(m.id)}
            >
              <div className="choice-icon">{m.icon}</div>
              <div className="choice-title">
                {m.title}
              </div>
              <div className="choice-desc">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!sel}
        nextLabel={sel ? "Configure access" : "Choose a mode"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdp });
