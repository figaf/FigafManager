/* global React, ReactDOM,
   WinFrame, StepperRail, WizardFooter, TerminalDrawer,
   ScreenWelcome, ScreenLogin, ScreenChoice, ScreenConfig, ScreenProgress, ScreenDeploy, ScreenDone,
   ScreenXsuaaUpgrade, ScreenXsuaaAssignRole,
   ScreenUpdateConfig, ScreenUpdateProgress,
   ScreenConnectProvision, ScreenConnectIdp,
   ScreenConnectIdpSuser, ScreenConnectIdpPassport, ScreenConnectIdpIas,
   ScreenConnectIdpCustomTrust, ScreenConnectIdpCustomAssign */

function App() {
  const [step, setStepRaw] = React.useState(0);
  const [terminalOpen, setTerminalOpen] = React.useState(false);

  const isHosted = window.figafModeFlags.isHosted;

  const [ctx, setCtx] = React.useState({
    prereqsStarted: false,
    deployStarted: false,
    prereqs: isHosted ? [
      // In hosted mode the CLIs are bundled and disk is irrelevant; only check Docker Hub
      { id: "btp",  status: "pending", title: "SAP BTP CLI",          sub: "bundled in container" },
      { id: "cf",   status: "pending", title: "Cloud Foundry CLI",    sub: "bundled in container" },
      { id: "net",  status: "pending", title: "Docker Hub reachable", sub: "hub.docker.com · latest Figaf image tag" },
      { id: "disk", status: "pending", title: "Container ready",      sub: "filesystem check" },
    ] : [
      { id: "btp",  status: "pending", title: "SAP BTP CLI",          sub: "btp login detected on PATH" },
      { id: "cf",   status: "pending", title: "Cloud Foundry CLI",    sub: "cf login detected on PATH" },
      { id: "net",  status: "pending", title: "Docker Hub reachable", sub: "hub.docker.com · latest Figaf image tag" },
      { id: "disk", status: "pending", title: "Disk space",           sub: "≥ 2 GB available for deployment artifacts" },
    ],
    login: {
      btpStatus: "idle",
      cfStatus: "idle",
      passcodeRequested: false,
      passcode: "",
      user: "",
      landscape: "",
      apiUrl: "",
      subaccount: "",
      subdomain: "",
      provider: "",
      org: "",
      space: "",
    },
    choice: null,
    config: {
      id: "figaf-tool",
      domain: "",
      locationId: "",
      dbPlan: "trial",
      dockerVersion: "",
      instanceMemory: "3700M",
      maxRamPercentage: "50",
      logsTotalSizeCap: "2GB",
      enableInstanceMonitoring: true,
      useCloudConnectorForSmtpIntegration: false,
      cloudConnectorDestinationNameForSmtpIntegration: "",
      // PostgreSQL service params (db.json). trialPg is undefined until
      // ScreenConfig seeds it from the login subdomain; dbParams collects the
      // per-field overrides the operator types into the form.
      trialPg: undefined,
      dbParams: {},
    },
    dbPlans: [
      { name: "trial",       description: "Trial PostgreSQL service offering",              free: true,  size: "shared" },
      { name: "development", description: "Small dev database · single AZ · 4 GB storage", free: false, size: "S"    },
      { name: "standard",    description: "Production · HA · 32 GB storage · backups",      free: false, size: "M"    },
    ],
    tasks: [
      { id: "vars",  status: "pending", title: "Update vars.yml",                     sub: "ID · LANDSCAPE_APPS_DOMAIN · LOCATION_ID · DOCKER_IMAGE_VERSION" },
      { id: "db",    status: "pending", title: "Create PostgreSQL service (figaf-db)", sub: "cf create-service postgresql-db · poll every 10s" },
      { id: "xsuaa", status: "pending", title: "Create XSUAA service (figaf-xsuaa)",   sub: "cf create-service xsuaa application" },
      { id: "roles", status: "pending", title: "Assign role collection",               sub: "btp assign security/role-collection IRTAdmin (after XSUAA)" },
    ],
    pushStatus: "idle",
    pushStarted: false,
    // Populated by ScreenUpdateConfig + ScreenUpdateProgress when the
    // operator picks the "Update Figaf Tool" branch on the choice screen.
    update: {
      deployId: "figaf-tool",
      detection: null,
      availableTags: [],
      targetTag: "",
      skipXsuaa: false,
      // vars.yml fields seeded from the LIVE app via update:readCurrentConfig
      // (not the template defaults) so an update never silently changes memory,
      // domain, location, or SMTP settings. strategy picks the cf push mode.
      vars: {},
      strategy: "recreate",
      resumeState: null,
      previousImage: null,
      verify: null,
    },
    // Populated by the Connect-to-Integration-Suite branch (ScreenConnect*).
    // tasks: 4-row checklist driving ScreenConnectProvision.
    // keys: parsed service-key JSONs; cleared when the operator backs out.
    // idpMode: selected on ScreenConnectIdp, drives which stub renders next.
    connect: {
      marketplaceOk: null,
      tasks: [
        { id: "create-api",   status: "pending", title: "Create it-rt/api service",              sub: "cf create-service it-rt api figaf-api" },
        { id: "create-iflow", status: "pending", title: "Create it-rt/integration-flow service", sub: "cf create-service it-rt integration-flow figaf-iflow" },
        { id: "key-api",      status: "pending", title: "Create + fetch API service key",        sub: "cf create-service-key + cf service-key" },
        { id: "key-iflow",    status: "pending", title: "Create + fetch iFlow service key",      sub: "cf create-service-key + cf service-key" },
      ],
      keys: { api: null, iflow: null },
      idpMode: null,
      iasUrl: null,
      // Custom-IDP branch state.
      idpName: "figaf-saml",
      samlGroup: "Admin",
      originKey: null,
      trustList: null,
      piRoles: [
        { id: "PI_Administrator",         status: "pending" },
        { id: "PI_Business_Expert",       status: "pending" },
        { id: "PI_Integration_Developer", status: "pending" },
      ],
      sso: { status: "idle", url: null, alias: null, error: null },
    },
  });

  const [logs, setLogs] = React.useState([
    { type: "dim", text: "# Figaf Manager" },
    { type: "dim", text: "# Ready to check environment" },
  ]);
  const appendLog = React.useCallback((lines) => {
    setLogs(prev => [...prev, ...lines]);
  }, []);

  // Subscribe to main-process CLI stream
  React.useEffect(() => {
    const api = typeof window !== "undefined" ? window.figaf : null;
    if (!api || !api.on) return;
    const typeMap = { cmd: "cmd", line: "out", err: "err", ok: "ok", warn: "warn", dim: "dim" };
    const off = api.on("cli:line", (msg) => {
      if (!msg) return;
      const t = typeMap[msg.type] || "out";
      setLogs(prev => [...prev, { type: t, text: msg.text }]);
    });
    return () => off && off();
  }, []);

  const baseSteps = [
    { id: "welcome",  label: "Welcome",            sub: "Check prerequisites" },
    { id: "login",    label: "Sign in",            sub: "BTP · Cloud Foundry" },
    { id: "choice",   label: "Choose action",      sub: "Deploy or connect" },
  ];

  const deploySteps = [
    { id: "config",   label: "Configuration",      sub: "vars.yml · DB plan" },
    { id: "progress", label: "Provision",          sub: "Services & roles" },
    { id: "deploy",   label: "Deploy",             sub: "cf push" },
    { id: "done",     label: "Finish",             sub: "Open Figaf Tool" },
  ];

  const connectTail =
    ctx.connect.idpMode === "custom-idp"
      ? [
          { id: "connect-idp-custom-trust",  label: "Create trust",  sub: "Cockpit SAML config" },
          { id: "connect-idp-custom-assign", label: "Assign & link", sub: "Roles · SSO URL" },
        ]
      : [{ id: "connect-idp-stub", label: "Configure", sub: "Mode-specific setup" }];

  const connectSteps = [
    { id: "connect-provision", label: "Provision",   sub: "it-rt · service keys" },
    { id: "connect-idp",       label: "BTP access",  sub: "Pick auth mode" },
    ...connectTail,
    { id: "done",              label: "Finish",      sub: "Integration Suite linked" },
  ];

  // v2: dedicated branch for the XSUAA upgrade flow. Entered either from
  // ScreenChoice (third option, hosted+token mode) or from ScreenDone after
  // a deploy finishes.
  const xsuaaSteps = [
    { id: "xsuaa-upgrade",     label: "Authentication",  sub: "Create XSUAA + approuter" },
    { id: "xsuaa-assign-role", label: "Role assignment", sub: "Cockpit deep-link" },
    { id: "done",              label: "Finish",          sub: "Persistent SSO live" },
  ];

  const updateSteps = [
    { id: "updateConfig",   label: "Configure update", sub: "Target tag · advanced vars" },
    { id: "updateProgress", label: "Apply update",     sub: "XSUAA · rolling push · verify" },
    { id: "done",           label: "Finish",           sub: "New image live" },
  ];

  // The stepper rail shows only the 3 base steps (Welcome / Sign in / Choose
  // action) until the operator picks an option on the choice screen. As soon
  // as ctx.choice flips, STEPS expands to include the chosen branch's tail.
  const STEPS =
    ctx.choice === "deploy"        ? [...baseSteps, ...deploySteps] :
    ctx.choice === "connect"       ? [...baseSteps, ...connectSteps] :
    ctx.choice === "xsuaa-upgrade" ? [...baseSteps, ...xsuaaSteps] :
    ctx.choice === "update"        ? [...baseSteps, ...updateSteps] :
    baseSteps;

  const currentStep = Math.min(step, STEPS.length - 1);
  const setStep = (n) => setStepRaw(Math.max(0, Math.min(STEPS.length - 1, n)));

  const maxReached = Math.max(currentStep, 0);
  const currentCmd = logs.slice().reverse().find(l => l.type === "cmd")?.text || "Ready.";

  const next = () => setStep(currentStep + 1);
  const back = () => setStep(currentStep - 1);

  let Screen;
  switch (STEPS[currentStep].id) {
    case "welcome":           Screen = <ScreenWelcome ctx={ctx} setCtx={setCtx} onNext={next} />; break;
    case "login":             Screen = <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={next} appendLog={appendLog} />; break;
    case "choice":            Screen = <ScreenChoice ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "config":            Screen = <ScreenConfig ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "progress":          Screen = <ScreenProgress ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "deploy":            Screen = <ScreenDeploy ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "xsuaa-upgrade":     Screen = <ScreenXsuaaUpgrade ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "xsuaa-assign-role": Screen = <ScreenXsuaaAssignRole ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "updateConfig":      Screen = <ScreenUpdateConfig ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "updateProgress":    Screen = <ScreenUpdateProgress ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-provision": Screen = <ScreenConnectProvision ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "connect-idp":       Screen = <ScreenConnectIdp ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-idp-stub":
      switch (ctx.connect && ctx.connect.idpMode) {
        case "s-user":       Screen = <ScreenConnectIdpSuser    ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "sap-passport": Screen = <ScreenConnectIdpPassport ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        case "ias":          Screen = <ScreenConnectIdpIas      ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
        default:             Screen = null;
      }
      break;
    case "connect-idp-custom-trust":  Screen = <ScreenConnectIdpCustomTrust  ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "connect-idp-custom-assign": Screen = <ScreenConnectIdpCustomAssign ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "done":              Screen = <ScreenDone ctx={ctx} setCtx={setCtx} setStep={setStepRaw} STEPS={STEPS} />; break;
    default: Screen = null;
  }

  return (
    <WinFrame>
      <StepperRail steps={STEPS} current={currentStep} maxReached={maxReached} />
      <div className="pane">
        {Screen}
        <TerminalDrawer
          open={terminalOpen}
          onToggle={() => setTerminalOpen(o => !o)}
          lines={logs}
          currentCmd={currentCmd}
        />
      </div>
    </WinFrame>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
