/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3b. SAP Passport stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpPassport({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · SAP Passport</div>
          <h1 className="pane-title">SAP Passport — coming soon</h1>
          <p className="pane-desc">
            Certificate-based access for SAP-managed customers. We'll wire
            up certificate selection + binding here. For now, finish the
            setup manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpPassport });
