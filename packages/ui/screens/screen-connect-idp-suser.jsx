/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3a. S-User — informational configuration guide
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpSuser({ ctx, setCtx, onNext, onBack }) {
  const roles = [
    "PI_Administrator",
    "PI_Business_Expert",
    "PI_Integration_Developer",
    "APIPortal.Administrator",
  ];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · S-User</div>
          <h1 className="pane-title">S-User authentication</h1>
          <p className="pane-desc">
            Use your SAP S-User or P-User to give Figaf access to Integration
            Suite. There is nothing to configure here — enter the credentials
            directly in the Figaf Tool after the wizard finishes.
          </p>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Prerequisites</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
            <li>
              The user must be able to log in via the{" "}
              <span className="kbd">sap.default</span> profile — the{" "}
              <em>Default Identity Provider</em> entry in Trust Configuration.
            </li>
            <li>
              Universal ID is <strong>not supported</strong>. Only use S-Users
              that are not linked to a Universal ID account.
            </li>
            <li>
              Ensure the user has no pending password change before configuring.
            </li>
            <li>
              For security, restrict the S-User to Integration Suite only and
              avoid granting global BTP admin roles.
            </li>
          </ul>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Required Integration Suite roles
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--ink-3)" }}>
            Assign all of these role collections to the S-User inside
            Integration Suite before connecting.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {roles.map((r) => (
              <span key={r} className="kbd">{r}</span>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 14, background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            <strong style={{ color: "var(--ink-2)" }}>SAP Neo environments:</strong>{" "}
            S-User is the only available option for Neo. Universal ID is not a
            concern there.
          </div>
        </div>
      </div>

      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpSuser });
