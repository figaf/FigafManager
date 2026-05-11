/* global React, ReactDOM,
   WinFrame, StepperRail, WizardFooter, TerminalDrawer,
   ScreenWelcome, ScreenLogin, ScreenChoice, ScreenConfig, ScreenProgress, ScreenDeploy, ScreenDone */

function App() {
  const [step, setStepRaw] = React.useState(0);
  const [terminalOpen, setTerminalOpen] = React.useState(false);

  const isHosted = typeof window !== "undefined" && window.figafMode === "hosted";

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
      org: "",
      space: "",
    },
    choice: "deploy",
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
      { id: "roles", status: "pending", title: "Assign role collection",               sub: "btp assign security/role-collection PI_Administrator" },
    ],
    pushStatus: "idle",
    pushStarted: false,
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

  const connectSteps = [
    { id: "done",     label: "Finish",             sub: "Integration Suite setup" },
  ];

  const STEPS = ctx.choice === "deploy"
    ? [...baseSteps, ...deploySteps]
    : [...baseSteps, ...connectSteps];

  const currentStep = Math.min(step, STEPS.length - 1);
  const setStep = (n) => setStepRaw(Math.max(0, Math.min(STEPS.length - 1, n)));

  const maxReached = Math.max(currentStep, 0);
  const currentCmd = logs.slice().reverse().find(l => l.type === "cmd")?.text || "Ready.";

  const next = () => setStep(currentStep + 1);
  const back = () => setStep(currentStep - 1);

  let Screen;
  switch (STEPS[currentStep].id) {
    case "welcome":  Screen = <ScreenWelcome ctx={ctx} setCtx={setCtx} onNext={next} />; break;
    case "login":    Screen = <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={next} appendLog={appendLog} />; break;
    case "choice":   Screen = <ScreenChoice ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />; break;
    case "config":   Screen = <ScreenConfig ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "progress": Screen = <ScreenProgress ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "deploy":   Screen = <ScreenDeploy ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />; break;
    case "done":     Screen = <ScreenDone ctx={ctx} />; break;
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
