/* global React, Ico */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// 7. Completion
// ═══════════════════════════════════════════════════════════
function ScreenDone({ ctx }) {
  const appUrl = `https://${ctx.config.id || "figaf-tool"}.${ctx.config.domain || `cfapps.${ctx.login.landscape.replace(/^cf-/, '')}.hana.ondemand.com`}`;
  const open = () => fg()?.shell.openExternal(appUrl);
  const isHosted = window.figafModeFlags.isHosted;

  const [deleteState, setDeleteState] = React.useState("idle"); // idle | running | done | error

  async function handleDeleteManager() {
    const api = fg();
    if (!api) return;
    setDeleteState("running");
    try {
      const r = await api.cf.deleteApp({ name: "figaf-manager" });
      if (r && r.ok === false) {
        setDeleteState("error");
      } else {
        setDeleteState("done");
      }
    } catch {
      setDeleteState("error");
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="success-splash">
          <div className="success-ring">
            <div className="sr-inner">
              <Ico.Check style={{ width: 24, height: 24, strokeWidth: 2.5 }} />
            </div>
          </div>
          <h1 className="pane-title" style={{ textAlign: "center" }}>Figaf is live.</h1>
          <p className="pane-desc" style={{ textAlign: "center", maxWidth: "48ch" }}>
            Your deployment is running on SAP BTP Cloud Foundry. Open the tool to sign in and start configuring your test suites.
          </p>
        </div>

        <div className="summary-grid" style={{ marginBottom: 18 }}>
          <div className="cell"><div className="k">App URL</div><div className="v" style={{ color: "var(--fg-blue)" }}>{appUrl}</div></div>
          <div className="cell"><div className="k">Image tag</div><div className="v">figaf/app:{ctx.config.dockerVersion || ctx.config.locationId}</div></div>
          <div className="cell"><div className="k">Database</div><div className="v">figaf-db · {ctx.config.dbPlan}</div></div>
          <div className="cell"><div className="k">Auth</div><div className="v">figaf-xsuaa</div></div>
          <div className="cell"><div className="k">Org / Space</div><div className="v">{ctx.login.org || "—"} / {ctx.login.space || "—"}</div></div>
          <div className="cell"><div className="k">Location ID</div><div className="v">{ctx.config.locationId || "—"}</div></div>
        </div>

        {isHosted && deleteState === "done" && (
          <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--fg-blue-soft, rgba(21,101,216,0.07))", border: "1px solid rgba(21,101,216,0.18)", fontSize: 13, color: "var(--ink-2)" }}>
            <strong style={{ color: "var(--ink-0)" }}>Manager app deleted.</strong>{" "}
            This tab will stop responding shortly — that's expected. You can close it.
          </div>
        )}
      </div>

      <div className="pane-foot">
        {isHosted && deleteState !== "done" && (
          <button
            className="btn"
            style={{ color: "var(--error, #e11d48)", borderColor: "rgba(225,29,72,0.3)" }}
            onClick={handleDeleteManager}
            disabled={deleteState === "running"}
          >
            <Ico.Trash />
            {deleteState === "running" ? "Deleting…" : deleteState === "error" ? "Delete failed — retry" : "Delete this manager app"}
          </button>
        )}
        <div className="spacer" />
        <button className="btn btn-primary" onClick={open}>
          Open Figaf Tool <Ico.External />
        </button>
      </div>
    </>
  );
}

Object.assign(window, { ScreenDone });
