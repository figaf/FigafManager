/* global React, Ico,
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

// Setup checklist on the landing page: the install steps in order, each with
// what it gives (why) and what it needs (when). Steps come from
// window.figafSetupSteps (setup-checklist.js); done steps stay visible but
// compact; the first actionable step is highlighted. Hidden once all are done.
function SetupChecklist({ setup, onDismiss }) {
  if (!setup || !setup.steps || setup.steps.length === 0) return null;
  if (setup.done >= setup.total) return null;
  return (
    <div className="card setup-checklist">
      <div className="setup-head">
        <div style={{ fontWeight: 700 }}>Set up this installation</div>
        <span className="pill blue">{setup.done} of {setup.total} done</span>
        <span className="setup-hint">Follow the order. Each step says what it gives and what it needs.</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn-link" onClick={onDismiss}>Hide</button>
      </div>
      {setup.steps.map((s) => (
        <div
          key={s.id}
          data-step={s.id}
          className={`setup-step ${s.done ? "is-done" : s.current ? "is-current" : s.blocked ? "is-blocked" : ""}`}
        >
          <div className="setup-num">{s.done ? <Ico.Check /> : s.n}</div>
          <div className="setup-body">
            <div className="setup-title">
              <span>{s.n}. {s.title}</span>
              {s.done && <span className="pill green">done</span>}
              {!s.done && s.current && <span className="pill blue">current step</span>}
              {!s.done && !s.current && s.blocked && <span className="pill gray">{s.blocked}</span>}
            </div>
            {!s.done && <div className="setup-why">{s.why}</div>}
            {!s.done && s.when && <div className="setup-when">{s.when}</div>}
          </div>
          {!s.done && s.cta && s.action && (
            <button
              className="btn"
              onClick={s.action}
              disabled={!!s.blocked}
              title={s.blocked ? `Available ${s.blocked}` : undefined}
            >
              {s.cta}
            </button>
          )}
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
      const [l3, figaf, stored, services] = await Promise.all([
        api.l3.status().catch((e) => ({ ok: false, error: e.message })),
        api.connections.figafStatus().catch((e) => ({ ok: false, error: e.message })),
        api.login.storedUserStatus().catch(() => null),
        (api.l3.services ? api.l3.services() : Promise.resolve(null)).catch(() => null),
      ]);
      if (!cancelled) setChecklist({ l3, figaf, stored, services });
    })();
    return () => { cancelled = true; };
  }, [signedIn, checklist]);

  // The dashboard reports every fresh l3:status (after install/remove/refresh);
  // keep the checklist's platform item in step without re-fetching the rest.
  const onL3Status = React.useCallback((s) => {
    setChecklist((c) => (c ? { ...c, l3: s } : c));
  }, []);
  const onL3Services = React.useCallback((s) => {
    setChecklist((c) => (c ? { ...c, services: s } : c));
  }, []);

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
    const setup = checklist ? buildSetupChecklist(checklist, { navigate, startFlow }) : null;
    page = (
      <>
        {!checklistHidden && checklist && (
          <div style={{ padding: "16px 28px 0" }}>
            <SetupChecklist setup={setup} onDismiss={() => setChecklistHidden(true)} />
          </div>
        )}
        <ScreenL3Apps
          ctx={ctx}
          setCtx={setCtx}
          onConnections={() => navigate("connections")}
          onStatus={onL3Status}
          onServices={onL3Services}
        />
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
// Steps from the shared model + the console's navigation actions.
function buildSetupChecklist(data, { navigate, startFlow }) {
  const build = typeof window !== "undefined" ? window.figafSetupSteps : null;
  if (typeof build !== "function") return null;
  const ssoDone = typeof window !== "undefined" && window.figafXsuaaMode === true;
  const result = build(data, { ssoDone });
  const actions = {
    "mgmt-user": () => navigate("session"),
    "figaf-connection": () => navigate("connections"),
    "sso": () => startFlow("xsuaa-upgrade"),
  };
  for (const s of result.steps) s.action = actions[s.id] || null;
  return result;
}

Object.assign(window, { ConsoleFrame });
