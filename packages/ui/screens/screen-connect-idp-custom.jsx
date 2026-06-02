/* global React, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Connect · 3d. Custom IDP stub (future PR replaces this)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustom({ ctx, setCtx, onNext, onBack }) {
  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Custom IDP — coming soon</h1>
          <p className="pane-desc">
            Bring your own SAML/OIDC provider. We'll wire up metadata
            import + attribute mapping here. For now, configure your IDP
            manually in the Figaf Tool and continue.
          </p>
        </div>
      </div>
      <WizardFooter onBack={onBack} onNext={onNext} nextLabel="Continue to finish" />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustom });
