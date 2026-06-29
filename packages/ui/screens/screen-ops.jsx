/* global React, Ico, CheckRow, WizardFooter */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// 5. Service creation + role assignment
// ═══════════════════════════════════════════════════════════
function ScreenProgress({ ctx, setCtx, onNext, onBack, appendLog }) {
  const tasks = ctx.tasks;
  const allDone = tasks.every(t => t.status === "done");

  React.useEffect(() => {
    if (ctx.deployStarted) return;
    setCtx(c => {
      const extra = [];
      if (ctx.config.enableConnectivity) extra.push({ id: "connectivity", status: "pending", title: "Create Connectivity service (figaf-connectivity)", sub: "cf create-service connectivity lite" });
      if (ctx.config.enableDestination)  extra.push({ id: "destination",  status: "pending", title: "Create Destination service (figaf-destination)",   sub: "cf create-service destination lite" });
      return { ...c, deployStarted: true, tasks: [...c.tasks, ...extra] };
    });
    const api = fg();
    if (!api) return;

    const mark = (id, patch) =>
      setCtx(c => ({ ...c, tasks: c.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }));

    (async () => {
      // 1. vars.yml — written in config step; just mark done
      mark("vars", { status: "done", sub: "vars.yml updated" });

      // 2. db creation runs fully in parallel — no dependency on XSUAA.
      const dbName = ctx.config.dbServiceName || "figaf-db";
      const dbPromise = (async () => {
        mark("db", { status: "running", title: `Create PostgreSQL service (${dbName})` });
        const c1 = await api.cf.createService({
          offering: "postgresql-db", plan: ctx.config.dbPlan, name: dbName, configFile: "db.json",
        });
        if (!c1.ok) { mark("db", { status: "error", sub: c1.stderr || "create-service failed" }); return; }
        const p1 = await api.cf.pollService(dbName);
        mark("db", { status: p1.ok ? "done" : "error", sub: p1.status });
      })();

      // 3. XSUAA creation, THEN role assignment chained off it.
      //
      // The IRTAdmin role collection is not a standalone object — it is
      // materialized in the subaccount by xs-security.json the moment
      // `cf create-service xsuaa application figaf-xsuaa` reaches
      // status: succeeded. So the assign MUST wait for that poll to
      // succeed. Running it in parallel (the old behavior) only ever
      // worked on subaccounts where a prior deployment had already left
      // the role collection behind; on a fresh subaccount the assign
      // raced ahead of materialization and failed with "role collection
      // not found".
      const xsRolePromise = (async () => {
        mark("xsuaa", { status: "running" });
        const c2 = await api.cf.createService({
          offering: "xsuaa", plan: "application", name: "figaf-xsuaa", configFile: "xs-security.json",
        });
        if (!c2.ok) { mark("xsuaa", { status: "error", sub: c2.stderr || "create-service failed" }); return; }
        const p2 = await api.cf.pollService("figaf-xsuaa");
        mark("xsuaa", { status: p2.ok ? "done" : "error", sub: p2.status });
        if (!p2.ok) {
          mark("roles", { status: "error", sub: "skipped — XSUAA not ready" });
          return;
        }

        // XSUAA is up and the role collections are now materialized.
        mark("roles", { status: "running" });
        const users = await api.btp.listUsers();
        const who = ctx.login.user || (users.ok && users.users[0]) || "";
        if (!who) { mark("roles", { status: "error", sub: "no user found" }); return; }
        const r = await api.btp.assignRole(who, "IRTAdmin");
        mark("roles", { status: r.ok ? "done" : "error", sub: r.ok ? `assigned IRTAdmin to ${who}` : (r.stderr || "failed") });
      })();

      // 4. Optional: Connectivity service (PI/PO via SAP Cloud Connector)
      const connectivityPromise = ctx.config.enableConnectivity ? (async () => {
        mark("connectivity", { status: "running" });
        const c = await api.cf.createService({ offering: "connectivity", plan: "lite", name: "figaf-connectivity" });
        mark("connectivity", { status: c.ok ? "done" : "error", sub: c.ok ? (c.alreadyExists ? "already exists" : "created") : (c.stderr || "create-service failed") });
      })() : Promise.resolve();

      // 5. Optional: Destination service (PI/PO via SAP Cloud Connector)
      const destinationPromise = ctx.config.enableDestination ? (async () => {
        mark("destination", { status: "running" });
        const c = await api.cf.createService({ offering: "destination", plan: "lite", name: "figaf-destination" });
        mark("destination", { status: c.ok ? "done" : "error", sub: c.ok ? (c.alreadyExists ? "already exists" : "created") : (c.stderr || "create-service failed") });
      })() : Promise.resolve();

      await Promise.all([dbPromise, xsRolePromise, connectivityPromise, destinationPromise]);
    })();
    // eslint-disable-next-line
  }, []);

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · Provisioning</div>
          <h1 className="pane-title">
            {allDone ? "Services ready" : "Creating services & assigning roles…"}
          </h1>
          <p className="pane-desc">
            {allDone
              ? "All services and the IRTAdmin role are configured. Ready to deploy the app."
              : <>Creating services in <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span> and assigning role collections. Most tasks run in parallel.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {tasks.map(t => <CheckRow key={t.id} {...t} />)}
          </div>
        </div>

        {!allDone && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
            <Ico.Terminal style={{ color: "var(--fg-blue)" }} />
            <span>Expand <strong>CLI details</strong> below to watch raw output.</span>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!allDone}
        nextLabel={allDone ? "Continue to deploy" : "Provisioning…"}
        backLabel="Cancel"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 6. Deploy app (cf push)
// ═══════════════════════════════════════════════════════════
function ScreenDeploy({ ctx, setCtx, onNext, onBack, appendLog }) {
  const pushStatus = ctx.pushStatus;
  const done = pushStatus === "done";
  const failed = pushStatus === "error";

  React.useEffect(() => {
    if (ctx.pushStarted) return;
    setCtx(c => ({ ...c, pushStarted: true, pushStatus: "running" }));
    const api = fg();
    if (!api) return;
    (async () => {
      const r = await api.cf.push();
      setCtx(c => ({ ...c, pushStatus: r.ok ? "done" : "error" }));
    })();
    // eslint-disable-next-line
  }, []);

  const appUrl = `https://${ctx.config.id}.${ctx.config.domain}`;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · Deploy</div>
          <h1 className="pane-title">
            {done ? "Application deployed" : failed ? "Deployment failed" : "Pushing Figaf Tool to Cloud Foundry…"}
          </h1>
          <p className="pane-desc">
            {done
              ? "The Figaf Tool is live and bound to all services."
              : failed
                ? "cf push exited with a non-zero code. Expand the CLI drawer to see the error."
                : <>Running <span className="kbd">cf push --vars-file vars.yml</span> — uploading, staging, and starting instances.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "20px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: done ? "var(--success-soft)" : "var(--fg-blue-soft)", border: `2px solid ${done ? "var(--success)" : "var(--fg-blue)"}`, color: done ? "var(--success)" : "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              {done ? <Ico.Check style={{ width: 20, height: 20 }} /> : <Ico.Spinner style={{ width: 20, height: 20 }} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-0)", marginBottom: 4 }}>
                {done ? "Deployment complete" : failed ? "Push failed" : "Uploading and staging…"}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                {done ? appUrl : "cf push --vars-file vars.yml"}
              </div>
            </div>
            {done && <span className="pill green">Live</span>}
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
          <Ico.Info style={{ color: "var(--fg-blue)" }} />
          <span>
            This step uploads the Docker image, binds services, and starts the app. Typically takes 2–5 minutes.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!done}
        nextLabel={done ? "Finish" : failed ? "Retry or cancel" : "Deploying…"}
        backLabel="Cancel"
      />
    </>
  );
}

Object.assign(window, { ScreenProgress, ScreenDeploy });
