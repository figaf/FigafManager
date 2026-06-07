/* global React, Ico, WizardFooter */

const fgct = () => (typeof window !== "undefined" && window.figaf) || null;
// Logo + this screenshot use the same sibling-relative convention; the cloud
// server adds an explicit /saml-trust-cockpit.png route (see server.js). Use
// the conventional figafModeFlags.isHosted signal (set by mode.js), matching
// how every other screen reads hosted-vs-desktop.
const SAML_SHOT = (typeof window !== "undefined" && window.figafModeFlags && window.figafModeFlags.isHosted)
  ? "/saml-trust-cockpit.png"
  : "./saml-trust-cockpit.png";

// ═══════════════════════════════════════════════════════════
// Connect · 3d-A. Custom IDP — create the SAML trust (manual cockpit step)
// ═══════════════════════════════════════════════════════════
function ScreenConnectIdpCustomTrust({ ctx, setCtx, onNext, onBack }) {
  const [url, setUrl] = React.useState(null);
  const [resolving, setResolving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [foundNames, setFoundNames] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  const idpName = ctx.connect.idpName;

  React.useEffect(() => {
    const api = fgct();
    if (!api) return;
    api.connect.trustConfigUrl().then((r) => { if (r && r.ok) setUrl(r.url); }).catch(() => {});
  }, []);

  function setField(key, value) {
    setCtx((c) => ({ ...c, connect: { ...c.connect, [key]: value } }));
  }

  async function openCockpit() {
    const api = fgct();
    if (api && url) await api.shell.openExternal(url);
  }

  async function copyUrl() {
    const api = fgct();
    if (!api || !url) return;
    try { await api.shell.writeClipboard(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }

  async function handleNext() {
    const api = fgct();
    if (!api) return;
    const name = (idpName || "").trim();
    if (!name) { setError("Enter the IDP name you created in the cockpit."); return; }
    setResolving(true); setError(null); setFoundNames(null);
    const r = await api.connect.resolveIdpOrigin(name);
    setResolving(false);
    if (!r || !r.ok) {
      setError((r && r.error) || "Could not resolve the IDP origin.");
      if (r && r.all) setFoundNames(r.all.map((e) => e.name));
      return;
    }
    setCtx((c) => ({ ...c, connect: { ...c.connect, originKey: r.originKey, trustList: r.all } }));
    onNext && onNext();
  }

  function handleBack() {
    // Back to the IDP picker — reset custom-IDP inputs to defaults.
    setCtx((c) => ({
      ...c,
      connect: { ...c.connect, idpName: "figaf-saml", samlGroup: "Admin", originKey: null, trustList: null },
    }));
    onBack && onBack();
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · BTP access · Custom IDP</div>
          <h1 className="pane-title">Create the SAML trust in the cockpit</h1>
          <p className="pane-desc">
            BTP has no CLI to import a SAML trust, so this step is manual. Open the
            Trust Configuration screen, click <strong>New SAML Trust Configuration</strong>
            {" "}(not <em>Establish Trust</em>), upload the file you downloaded from the
            Figaf Tool, and give it a name. Then enter that name below.
          </p>
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <button className="btn btn-primary" onClick={openCockpit} disabled={!url}>
              <Ico.Link /> Open Trust Configuration
            </button>
            <button className="btn" onClick={copyUrl} disabled={!url}>
              <Ico.Copy /> {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
          {url && (
            <div style={{ fontSize: 11, color: "var(--ink-3)", wordBreak: "break-all" }}>{url}</div>
          )}
        </div>

        <div className="card" style={{ padding: 12, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: "var(--ink-2)" }}>
            Cockpit reference — how the form should look
          </div>
          <img
            src={SAML_SHOT}
            alt="New SAML Trust Configuration form in the BTP cockpit"
            style={{ width: "50%", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
          />
        </div>

        <label style={{ display: "block" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>IDP name</div>
          <input
            className="input"
            value={idpName}
            onChange={(e) => setField("idpName", e.target.value)}
            placeholder="figaf-saml"
            style={{ width: "100%" }}
          />
        </label>

        {error && (
          <div className="card" style={{ padding: 12, marginTop: 14, borderColor: "var(--fg-red, #c0392b)" }}>
            <div style={{ color: "var(--fg-red, #c0392b)", fontSize: 13 }}>{error}</div>
            {foundNames && foundNames.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                Trusts found in this subaccount: {foundNames.join(", ")}. Save your new
                SAML trust in the cockpit, then press Continue again.
              </div>
            )}
          </div>
        )}
      </div>

      <WizardFooter
        onBack={handleBack}
        onNext={handleNext}
        nextDisabled={!idpName || !idpName.trim() || resolving}
        nextLabel={resolving ? "Checking…" : "Continue"}
      />
    </>
  );
}

Object.assign(window, { ScreenConnectIdpCustomTrust });
