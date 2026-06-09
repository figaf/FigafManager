/* global React, Ico, WizardFooter */

const SAP_PASSPORT_URL = "https://support.sap.com/en/my-support/single-sign-on-passports.html";

// ═══════════════════════════════════════════════════════════
// Connect · 3b. SAP Passport — informational configuration guide
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpPassport({ ctx, setCtx, onNext, onBack }) {
  const isHosted =
    typeof window !== "undefined" &&
    window.figafModeFlags &&
    window.figafModeFlags.isHosted;

  async function openPassportSite() {
    const api = (typeof window !== "undefined" && window.figaf) || null;
    if (!api) return;
    if (isHosted) {
      window.open(SAP_PASSPORT_URL, "_blank", "noopener,noreferrer");
    } else {
      await api.shell.openExternal(SAP_PASSPORT_URL);
    }
  }

  const steps = [
    {
      text: (
        <>
          Open the <strong>SAP Passport site</strong> and sign in with your
          S-User credentials.
        </>
      ),
    },
    {
      text: (
        <>
          Click <strong>Apply for an SAP Passport</strong>.
        </>
      ),
    },
    {
      text: (
        <>
          Enter your S-User password and select key length{" "}
          <span className="kbd">4096 (Highest Grade)</span>.
        </>
      ),
    },
    {
      text: (
        <>
          Click <strong>Apply for SAP Passport</strong> to generate the
          certificate.
        </>
      ),
    },
    {
      text: (
        <>
          <strong>Download the certificate</strong> and keep a note of the
          password you entered — you will need both in the Figaf Tool.
        </>
      ),
    },
  ];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP Passport</div>
          <h1 className="pane-title">SAP Passport authentication</h1>
          <p className="pane-desc">
            SAP Passport uses your S-User certificate instead of a password.
            Unlike plain S-User login it is not affected by Universal ID,
            which simplifies onboarding for most customers.
          </p>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Prerequisites</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
            <li>You need an existing SAP S-User account.</li>
            <li>
              The S-User must be able to log in to Integration Suite via the{" "}
              <span className="kbd">sap.default</span> profile (Default
              Identity Provider).
            </li>
          </ul>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 14,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              How to get your SAP Passport
            </div>
            <button className="btn btn-primary" onClick={openPassportSite}>
              <Ico.Link /> Open SAP Passport site
            </button>
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1 }}>
            {steps.map((s, i) => (
              <li key={i} style={{ marginBottom: 12 }}>
                {s.text}
              </li>
            ))}
          </ol>
        </div>

        <div
          className="card"
          style={{
            padding: 14,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            <strong style={{ color: "var(--ink-2)" }}>After downloading:</strong>{" "}
            Enter the certificate file and the password you set in the Figaf
            Tool's <em>SAP Passport</em> authentication section to complete the
            connection.
          </div>
        </div>
      </div>

      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpPassport });
