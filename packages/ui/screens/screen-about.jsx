/* global React */
// Console page: About & updates (#/about).
// Carries what the old Welcome step carried, without being a step:
//   - manager version + self-update check (the wizard's floating banner logic)
//   - the environment checks (bundled CLIs, Docker Hub, container), run
//     silently at console boot; the rail badge points here when one fails.

function AboutCheckRow({ p }) {
  const pill =
    p.status === "done" ? <span className="pill green">ok</span> :
    p.status === "error" ? <span className="pill" style={{ background: "var(--fg-red-soft, #fdecea)", color: "var(--fg-red, #c0392b)" }}>failed</span> :
    p.status === "running" ? <span className="pill blue">checking…</span> :
    <span className="pill gray">pending</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ width: 220, fontWeight: 600, fontSize: 13 }}>{p.title}</div>
      {pill}
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.sub}</div>
    </div>
  );
}

// One line of the Versions card: name, the value the container reports, an
// optional note (the build's pin), red when the two disagree.
function VersionRow({ name, value, note, ok }) {
  const bad = ok === false;
  return (
    <div data-version-row={name} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ width: 220, fontWeight: 600, fontSize: 13 }}>{name}</div>
      <span className="kbd" style={bad ? { color: "var(--fg-red, #c0392b)" } : undefined}>{value}</span>
      {note && (
        <span style={{ fontSize: 12, color: bad ? "var(--fg-red, #c0392b)" : "var(--ink-3)" }}>{note}</span>
      )}
    </div>
  );
}

// prereq:bundledVersions result for one CLI -> VersionRow props.
function cliRow(x) {
  if (!x) return { value: "…" };
  if (!x.ok) return { value: "did not start", note: x.raw || null, ok: false };
  const value = x.version || x.raw || "version unknown";
  if (x.expected && x.matches === false) return { value, note: `build pinned ${x.expected}`, ok: false };
  return { value, note: x.expected ? `build pinned ${x.expected}` : "no build record", ok: true };
}

// engines.node is a line like "22.x"; the runtime reports "v22.12.0".
function nodeMatches(runtime, engine) {
  if (!engine || !runtime) return undefined;
  const major = String(engine).match(/^\D*(\d+)/);
  return major ? runtime.replace(/^v/, "").split(".")[0] === major[1] : undefined;
}

function ScreenAbout({ ctx, setCtx, onRunChecks }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const versions = ctx.versions || null;
  const check = ctx.selfUpdate && ctx.selfUpdate.check;
  const version =
    (typeof window !== "undefined" && window.figafVersion) ||
    (check && check.current) || null;
  const [checking, setChecking] = React.useState(false);

  async function checkAgain() {
    setChecking(true);
    let result;
    try { result = await api.update.checkSelf(); }
    catch (e) { result = { ok: false, error: e.message }; }
    setCtx((c) => ({ ...c, selfUpdate: { ...c.selfUpdate, check: result } }));
    setChecking(false);
  }

  return (
    <div className="pane-body">
      <div className="pane-head">
        <div className="pane-eyebrow">About &amp; updates</div>
        <h1 className="pane-title">Figaf Manager</h1>
        <p className="pane-desc">
          Version <span className="kbd">{version ? `v${version}` : "…"}</span> · SAP BTP · Cloud Foundry
        </p>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Versions</div>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 8px" }}>
          What this manager runs with. The build pins the CLI and Node versions
          (<span className="kbd">bin/VERSIONS.json</span>); a difference shows in red.
        </p>
        {!versions && (
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Loading… (filled in by the checks that run at boot; use "Run checks again" below if it stays empty)
          </div>
        )}
        {versions && (
          <div>
            <VersionRow name="Manager" value={versions.manager ? `v${versions.manager}` : "…"} />
            <VersionRow
              name="Node.js runtime"
              value={versions.node || "…"}
              note={versions.nodeExpected ? `build pinned ${versions.nodeExpected}` : "not pinned by the build"}
              ok={nodeMatches(versions.node, versions.nodeExpected)}
            />
            <VersionRow name="btp CLI" {...cliRow(versions.btp)} />
            <VersionRow name="cf CLI" {...cliRow(versions.cf)} />
            {versions.npm && Object.entries(versions.npm).map(([n, v]) => (
              <VersionRow key={n} name={n} value={v || "?"} />
            ))}
            <VersionRow
              name="Built"
              value={versions.builtAt ? versions.builtAt.replace("T", " ").slice(0, 16) + " UTC" : "no build record"}
              note={versions.bundled ? null : "dev checkout: CLIs come from PATH"}
            />
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Manager updates</div>
        {!check && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>Checking for updates…</div>}
        {check && !check.ok && (
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Update service unreachable{check.error ? ` (${check.error})` : ""}. Not an error —
            the manager keeps working; try again later.
          </div>
        )}
        {check && check.ok && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {check.updateAvailable
              ? <span className="pill blue">update available: v{check.latest}</span>
              : <span className="pill green">up to date</span>}
            <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
              installed v{check.current} · latest v{check.latest}
            </span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={checkAgain} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
          {check && check.ok && check.updateAvailable && (
            <button
              className="btn btn-primary"
              onClick={() => setCtx((c) => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: true } }))}
            >
              Update now
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Environment checks</div>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 8px" }}>
          Run automatically when the console opens. A red mark on the menu points here.
        </p>
        {(ctx.prereqs || []).map((p) => <AboutCheckRow key={p.id} p={p} />)}
        {onRunChecks && (
          <div style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={onRunChecks}
              disabled={(ctx.prereqs || []).some((p) => p.status === "running")}
            >
              Run checks again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ScreenAbout });
