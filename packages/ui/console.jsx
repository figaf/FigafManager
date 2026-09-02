/* global React,
   WinFrame, FigafMark, TerminalDrawer, SelfUpdateBanner, UpdatePreflightModal,
   ScreenLogin, ScreenL3Apps, ScreenConnections,
   ScreenSession, ScreenAbout, ScreenFigafToolHub */
// Console frame (hosted mode): a persistent left-rail navigation instead of
// the one-time wizard. Pages are the existing screens; the four Figaf Tool
// flows (deploy / update / connect / SSO upgrade) keep their step sequence
// and render INSIDE the Figaf Tool page as a local stepper.
// Frame selection happens in app.jsx via features.consoleUI.

const CONSOLE_ROUTES = [
  { id: "apps",        hash: "#/apps",        label: "L3 Applications",  sub: "Install · update · health",  needsCf: true },
  { id: "connections", hash: "#/connections", label: "Connections",      sub: "Figaf tool · SAP systems",   needsCf: true },
  { id: "figaf-tool",  hash: "#/figaf-tool",  label: "Figaf Tool",       sub: "Deploy · update · connect",  needsCf: true },
  { id: "session",     hash: "#/session",     label: "Session & access", sub: "Sign-in · management user",  needsCf: false },
  { id: "about",       hash: "#/about",       label: "About & updates",  sub: "Version · checks",           needsCf: false },
];

// The wizard branches that are flows inside the Figaf Tool page.
const CONSOLE_FLOW_CHOICES = { deploy: 1, update: 1, connect: 1, "xsuaa-upgrade": 1 };

function consoleRouteFromHash(hash) {
  const r = CONSOLE_ROUTES.find((x) => x.hash === hash);
  return r ? r.id : "apps";
}

// Environment checks, run silently at console boot (the wizard ran them on
// the Welcome step). Mirrors ScreenWelcome's hosted branch: the CLIs are
// bundled, only Docker Hub is really probed.
async function runConsoleChecks(setCtx) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  if (!api || !api.prereq) return;
  const mark = (id, patch) =>
    setCtx((c) => ({ ...c, prereqs: c.prereqs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  setCtx((c) => ({ ...c, prereqsStarted: true }));
  mark("btp", { status: "done", sub: "bundled in container" });
  mark("cf", { status: "done", sub: "bundled in container" });
  mark("disk", { status: "done", sub: "container filesystem ready" });
  mark("net", { status: "running" });
  try {
    const r = await api.prereq.dockerHub();
    if (r && r.ok) mark("net", { status: "done", sub: r.latest ? `hub.docker.com · ${r.latest}` : "docker hub reachable" });
    else mark("net", { status: "error", sub: (r && r.error) || "unreachable" });
  } catch (e) {
    mark("net", { status: "error", sub: e.message });
  }
}

function ConsoleRail({ activeRoute, onNavigate, flowActive, aboutBadge, ctx, version }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <FigafMark size={26} />
        <div className="rail-brand-text">
          <span className="t1">Figaf Manager</span>
          <span className="t2">SAP BTP · Cloud Foundry</span>
        </div>
      </div>

      <nav className="cnav">
        {CONSOLE_ROUTES.map((r) => (
          <div
            key={r.id}
            data-route={r.id}
            className={`cnav-item ${activeRoute === r.id ? "is-active" : ""}`}
            onClick={() => onNavigate(r.id)}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(r.id); }}
          >
            <div className="cnav-label">
              {r.label}
              {r.id === "figaf-tool" && flowActive && <span className="cnav-dot blue" title="A flow is in progress" />}
              {r.id === "about" && aboutBadge && <span className="cnav-dot red" title={aboutBadge} />}
            </div>
            <div className="cnav-sub">{r.sub}</div>
          </div>
        ))}
      </nav>

      <div className="rail-foot" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        {ctx.login.cfStatus === "done" ? (
          <>
            <span>{ctx.login.user}</span>
            <span>{ctx.login.org} / {ctx.login.space}</span>
          </>
        ) : (
          <span>not signed in</span>
        )}
        <span>{version ? `v${version}` : ""} · figaf.com</span>
      </div>
    </aside>
  );
}

// First-run checklist banner on the landing page. Items come from the same
// handlers the pages use; "done" items disappear into a green count.
function SetupChecklist({ items, onDismiss }) {
  const open = items.filter((i) => !i.done);
  if (open.length === 0) return null;
  return (
    <div className="card setup-checklist">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Finish setting up this installation</div>
        <span className="pill blue">{items.length - open.length}/{items.length} done</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn-link" onClick={onDismiss}>Hide</button>
      </div>
      {open.map((i) => (
        <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line)", marginTop: 7 }}>
          <span className="pill gray">to do</span>
          <div style={{ fontSize: 13 }}>{i.label}</div>
          <div className="spacer" style={{ flex: 1 }} />
          {i.action && <button className="btn" onClick={i.action}>{i.cta}</button>}
        </div>
      ))}
    </div>
  );
}

function ConsoleFrame({ app }) {
  const {
    ctx, setCtx, logs, appendLog,
    step, setStepRaw, STEPS, renderScreenById,
    terminalOpen, setTerminalOpen, currentCmd,
  } = app;

  const [route, setRoute] = React.useState(() =>
    consoleRouteFromHash(typeof window === "undefined" ? "" : window.location.hash));
  const [checklist, setChecklist] = React.useState(null);   // null = not fetched
  const [checklistHidden, setChecklistHidden] = React.useState(false);

  const signedIn = ctx.login.cfStatus === "done";
  const flowActive = !!CONSOLE_FLOW_CHOICES[ctx.choice] && step >= 3;

  const navigate = React.useCallback((id) => {
    const r = CONSOLE_ROUTES.find((x) => x.id === id);
    if (!r) return;
    if (window.location.hash !== r.hash) window.location.hash = r.hash; // hashchange updates state
    else setRoute(id);
  }, []);

  // Keep state and address bar in sync (back button, hand-edited hash).
  React.useEffect(() => {
    const onHash = () => setRoute(consoleRouteFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    // Normalize the address on first load (empty hash → #/apps).
    const r = CONSOLE_ROUTES.find((x) => x.id === route);
    if (r && window.location.hash !== r.hash) window.history.replaceState(null, "", r.hash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line
  }, []);

  // Environment checks: once per console boot, silently.
  React.useEffect(() => {
    if (!ctx.prereqsStarted) runConsoleChecks(setCtx);
    // eslint-disable-next-line
  }, []);

  // Setup-checklist statuses: once per sign-in.
  React.useEffect(() => {
    if (!signedIn || checklist) return;
    const api = window.figaf;
    let cancelled = false;
    (async () => {
      const [l3, figaf, stored] = await Promise.all([
        api.l3.status().catch((e) => ({ ok: false, error: e.message })),
        api.connections.figafStatus().catch((e) => ({ ok: false, error: e.message })),
        api.login.storedUserStatus().catch(() => null),
      ]);
      if (!cancelled) setChecklist({ l3, figaf, stored });
    })();
    return () => { cancelled = true; };
  }, [signedIn, checklist]);

  const startFlow = React.useCallback((choiceId) => {
    setCtx((c) => ({ ...c, choice: choiceId }));
    setStepRaw(3); // base steps 0-2 are not rendered in the console; 3 = first tail step
    navigate("figaf-tool");
  }, [setCtx, setStepRaw, navigate]);

  const abandonFlow = React.useCallback(() => {
    setCtx((c) => ({ ...c, choice: null }));
    setStepRaw(2);
  }, [setCtx, setStepRaw]);

  // ── page content ──────────────────────────────────────────────────────────
  const activeRouteDef = CONSOLE_ROUTES.find((r) => r.id === route) || CONSOLE_ROUTES[0];
  let page = null;

  if (activeRouteDef.needsCf && !signedIn) {
    // Auth gate: the addressed page waits behind the sign-in card. While the
    // automatic sign-in (session resume / stored user) is still being tried,
    // show that instead of flashing the login form.
    page = ctx.login.autoStatus === "trying" ? (
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Signing in</div>
          <h1 className="pane-title">Connecting to Cloud Foundry…</h1>
          <p className="pane-desc">Resuming your session, or signing in with the stored management user.</p>
        </div>
      </div>
    ) : (
      <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={() => {}} appendLog={appendLog} gate />
    );
  } else if (route === "apps") {
    const items = checklist ? buildChecklistItems(checklist, { navigate, startFlow }) : [];
    page = (
      <>
        {!checklistHidden && checklist && (
          <div style={{ padding: "16px 28px 0" }}>
            <SetupChecklist items={items} onDismiss={() => setChecklistHidden(true)} />
          </div>
        )}
        <ScreenL3Apps ctx={ctx} setCtx={setCtx} onConnections={() => navigate("connections")} />
      </>
    );
  } else if (route === "connections") {
    page = <ScreenConnections ctx={ctx} setCtx={setCtx} />;
  } else if (route === "figaf-tool") {
    if (flowActive) {
      const tail = STEPS.slice(3);
      const flowIndex = Math.min(step, STEPS.length - 1) - 3;
      const stepId = STEPS[Math.min(step, STEPS.length - 1)].id;
      page = (
        <>
          <div className="flow-strip">
            <button className="btn-link" onClick={abandonFlow}>← Figaf Tool overview</button>
            <div className="spacer" style={{ flex: 1 }} />
            {tail.map((s, i) => (
              <span key={s.id} className={`flow-chip ${i === flowIndex ? "is-active" : i < flowIndex ? "is-done" : ""}`}>
                {s.label}
              </span>
            ))}
          </div>
          {renderScreenById(stepId)}
        </>
      );
    } else {
      page = <ScreenFigafToolHub ctx={ctx} onStartFlow={startFlow} onGoSession={() => navigate("session")} />;
    }
  } else if (route === "session") {
    page = <ScreenSession ctx={ctx} setCtx={setCtx} appendLog={appendLog} />;
  } else if (route === "about") {
    page = (
      <ScreenAbout
        ctx={ctx}
        setCtx={setCtx}
        onRunChecks={() => {
          setCtx((c) => ({ ...c, prereqs: c.prereqs.map((p) => ({ ...p, status: "pending" })), prereqsStarted: false }));
          runConsoleChecks(setCtx);
        }}
      />
    );
  }

  const prereqFailed = (ctx.prereqs || []).some((p) => p.status === "error");
  const updateAvailable = !!(ctx.selfUpdate && ctx.selfUpdate.check && ctx.selfUpdate.check.ok && ctx.selfUpdate.check.updateAvailable);
  const aboutBadge = prereqFailed ? "an environment check failed" : (updateAvailable ? "a manager update is available" : null);

  const currentStepId = flowActive && route === "figaf-tool" ? STEPS[Math.min(step, STEPS.length - 1)].id : route;
  const suppressSelfUpdate =
    typeof window !== "undefined" && window.figafIsLongRunningFlow
      ? window.figafIsLongRunningFlow(ctx, currentStepId)
      : false;

  return (
    <WinFrame>
      <ConsoleRail
        activeRoute={route}
        onNavigate={navigate}
        flowActive={flowActive}
        aboutBadge={aboutBadge}
        ctx={ctx}
        version={
          (typeof window !== "undefined" && window.figafVersion) ||
          (ctx.selfUpdate && ctx.selfUpdate.check ? ctx.selfUpdate.check.current : null)
        }
      />
      <div className="pane">
        <SelfUpdateBanner ctx={ctx} setCtx={setCtx} suppress={suppressSelfUpdate} />
        {page}
        <TerminalDrawer
          open={terminalOpen}
          onToggle={() => setTerminalOpen((o) => !o)}
          lines={logs}
          currentCmd={currentCmd}
        />
      </div>
      {ctx.selfUpdate && ctx.selfUpdate.preflightOpen && (
        <UpdatePreflightModal
          onClose={() => setCtx((c) => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: false } }))}
        />
      )}
    </WinFrame>
  );
}

// The four one-time setup marks for a fresh installation.
function buildChecklistItems(data, { navigate, startFlow }) {
  const ssoDone = typeof window !== "undefined" && window.figafXsuaaMode === true;
  const storedDone = !!(data.stored && data.stored.available);
  const figafDone = !!(data.figaf && data.figaf.configured);
  const platform = data.l3 && data.l3.ok ? data.l3.platform : null;
  const platformDone = !!(platform && platform.status === "running");
  return [
    {
      id: "sso",
      done: ssoDone,
      label: "Enable persistent SSO — access should survive redeploys (IAS sign-in instead of the setup token).",
      cta: "Start upgrade",
      action: () => startFlow("xsuaa-upgrade"),
    },
    {
      id: "mgmt-user",
      done: storedDone,
      label: "Store a management user, so the manager signs in without a passcode.",
      cta: "Session & access",
      action: () => navigate("session"),
    },
    {
      id: "platform",
      done: platformDone,
      label: "Deploy the platform base (shared connector) — installing the first app does this automatically.",
      cta: null,
      action: null,
    },
    {
      id: "figaf-connection",
      done: figafDone,
      label: "Connect the Figaf tool, so apps can list its systems.",
      cta: "Connections",
      action: () => navigate("connections"),
    },
  ];
}

Object.assign(window, { ConsoleFrame });
