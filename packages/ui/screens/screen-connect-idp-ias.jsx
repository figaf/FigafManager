/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3c. SAP User Identity Service stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpIas({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP User Identity Service</div>
          <h1 className="pane-title">SAP User Identity Service — coming soon</h1>
          <p className="pane-desc">
            IAS-backed federation: same identity as the cockpit. We'll wire
            up trust-bundle import + SAML mapping here. For now, configure
            it manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpIas });
