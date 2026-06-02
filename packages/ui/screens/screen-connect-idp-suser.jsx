/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3a. S-User stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpSuser({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · S-User</div>
          <h1 className="pane-title">S-User authentication — coming soon</h1>
          <p className="pane-desc">
            We're working on automating this path. For now, configure
            S-User access manually inside the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpSuser });
