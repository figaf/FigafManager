/* global React, Ico, WizardFooter */

// ═══════════════════════════════════════════════════════════
// 3. Post-login choice
// ═══════════════════════════════════════════════════════════
function ScreenChoice({ ctx, setCtx, onNext, onBack }) {
  const sel = ctx.choice;
  function pick(v) { setCtx(c => ({ ...c, choice: v })); }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 3 · Choose action</div>
          <h1 className="pane-title">What would you like to do?</h1>
          <p className="pane-desc">
            Signed in as <strong>{ctx.login.user || "you"}</strong> on <span className="kbd">{ctx.login.landscape}</span>. Pick how you'd like to continue — you can do the other later.
          </p>
        </div>

        <div className="choice-grid">
          <button
            className={`choice ${sel === "deploy" ? "selected" : ""}`}
            onClick={() => pick("deploy")}
          >
            <div className="choice-icon"><Ico.Box /></div>
            <div className="choice-title">
              Deploy Figaf Tool
              <span className="pill blue">Recommended</span>
            </div>
            <div className="choice-desc">
              Push the Figaf Tool to your Cloud Foundry space along with its PostgreSQL and XSUAA services.
            </div>
          </button>

          <button
            className={`choice ${sel === "connect" ? "selected" : ""}`}
            onClick={() => pick("connect")}
          >
            <div className="choice-icon"><Ico.Link /></div>
            <div className="choice-title">
              Connect to Integration Suite
            </div>
            <div className="choice-desc">
              Link an existing Figaf deployment to your SAP Integration Suite tenant for tracking & testing.
            </div>
          </button>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Ico.Info style={{ color: "var(--fg-blue)", flexShrink: 0, marginTop: 1 }} />
          <span>
            Fresh install? Choose <strong>Deploy</strong>. Already running Figaf and just need to wire up Integration Suite? Choose <strong>Connect</strong>.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!sel}
        nextLabel={sel === "connect" ? "Configure connection" : "Configure deployment"}
      />
    </>
  );
}

Object.assign(window, { ScreenChoice });
