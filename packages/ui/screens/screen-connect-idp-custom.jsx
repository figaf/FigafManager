/* global React, Ico, WizardFooter */

const fgct = () => (typeof window !== "undefined" && window.figaf) || null;
// Logo + this screenshot use the same sibling-relative convention; the cloud
// server adds an explicit /saml-trust-cockpit.png route (see server.js). Use
// the conventional figafModeFlags.isHosted signal (set by mode.js), matching
// how every other screen reads hosted-vs-desktop.
const SAML_SHOT = (typeof window !== "undefined" && window.figafModeFlags && window.figafModeFlags.isHosted)
  ? "/saml-trust-cockpit.png"
  : "./saml-trust-cockpit.png";

// Numbered-step layout primitives (local to this screen — mirrors the manual
// flow other connect screens spell out inline).
const stepRow = { display: "flex", gap: 12, alignItems: "flex-start" };
const numBadge = {
  width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
  background: "var(--fg-blue)", color: "#fff",
  fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center",
  marginTop: 1,
};
const stepText = { fontSize: 13, lineHeight: 1.5, color: "var(--ink-1)" };

// The cockpit screenshot used to sit on the page permanently; it now lives
// behind a "?" hint next to step 3. Shows on hover and pins open on click.
function SamlShotHint() {
  const [hover, setHover] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const show = hover || pinned;
  return (
    <span
      className="img-hint"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="img-hint-trigger"
        onClick={() => setPinned((p) => !p)}
        aria-label="Show how the cockpit form should look"
      >
        ?
      </button>
      {show && (
        <span className="img-hint-pop" onClick={() => setPinned(false)}>
          <img src={SAML_SHOT} alt="Add SAML Trust form in the BTP cockpit" />
          <span className="img-hint-cap">Cockpit reference — how the form should look</span>
        </span>
      )}
    </span>
  );
}

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
            BTP has no CLI to import a SAML trust, so this is the one manual step
            in the flow. You'll download a metadata file from the Figaf Tool and
            register it as a SAML trust in the SAP BTP cockpit, then enter the name
            you gave it below so the wizard can finish connecting.
          </p>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Step 1 — download the metadata file from the Figaf Tool */}
          <div style={stepRow}>
            <div style={numBadge}>1</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={stepText}>
                Download the entity description file from the Figaf Tool — select{" "}
                <strong>Custom IDP</strong> as the authentication mode.
              </div>
            </div>
          </div>

          {/* Step 2 — open Trust Configuration in the cockpit */}
          <div style={stepRow}>
            <div style={numBadge}>2</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
                <div style={stepText}>
                  Open the <strong>Trust Configuration</strong> page in the SAP BTP cockpit.
                </div>
                <button className="btn btn-primary" onClick={openCockpit} disabled={!url} style={{ flexShrink: 0 }}>
                  <Ico.External /> Open
                </button>
              </div>
              {url && (
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    className="btn"
                    onClick={copyUrl}
                    disabled={!url}
                    style={{ height: 26, padding: "0 10px", fontSize: 11 }}
                  >
                    <Ico.Copy /> {copied ? "Copied!" : "Copy link"}
                  </button>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", wordBreak: "break-all" }}>{url}</span>
                </div>
              )}
            </div>
          </div>

          {/* Step 3 — add the SAML trust + upload the file */}
          <div style={stepRow}>
            <div style={numBadge}>3</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={stepText}>
                Select <strong>Add SAML Trust</strong> and upload the downloaded file.
                Uncheck <strong>Available for User Logon</strong>.
                <SamlShotHint />
              </div>
            </div>
          </div>
        </div>

        <label style={{ display: "block" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            IDP name
            <span style={{ fontWeight: 400, color: "var(--ink-3)", marginLeft: 8 }}>
              — make sure this matches the name you gave the configuration
            </span>
          </div>
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
