// Setup checklist for the hosted console (first-run banner on #/apps).
// Pure logic, browser-globals like mode.js: console.jsx renders the result,
// setup-checklist.test.js runs it under node:test. No React, no I/O.
//
// Input `data` = the four results the banner already fetches:
//   services: l3:services            -> { ok, services: [{ name, status, bindToManager, boundToManager }] }
//   stored:   login:storedUserStatus -> { available, bindingPresent }
//   l3:       l3:status              -> { ok, platform: { status } }
//   figaf:    connections:figafStatus-> { configured }
// plus `ssoDone` (window.figafXsuaaMode). Every value may be missing.
//
// Output: ordered steps in the INSTALL order. Each step:
//   { id, n, title, why, when, done, blocked, current, cta }
//   blocked  = "" or the reason ("after step 1")
//   current  = first step that is neither done nor blocked
// Step 1 (base services) is omitted for a v2 release (no `services` block);
// numbering stays dense.

(function () {
  "use strict";

  function figafSetupSteps(data, opts) {
    data = data || {};
    var ssoDone = !!(opts && opts.ssoDone);
    var stored = data.stored || null;
    var bindingActive = !!(stored && stored.bindingPresent);
    var storedDone = !!(stored && stored.available);
    var figafDone = !!(data.figaf && data.figaf.configured);
    var platform = data.l3 && data.l3.ok ? data.l3.platform : null;
    var platformDone = !!(platform && platform.status === "running");

    var svc = data.services && data.services.ok ? (data.services.services || []) : null;
    var hasServices = !!(svc && svc.length > 0);
    var allReady = hasServices && svc.every(function (s) { return s.status === "ready"; });
    var missing = hasServices ? svc.filter(function (s) { return s.status !== "ready"; }) : [];
    var credstore = hasServices ? svc.filter(function (s) { return s.bindToManager; })[0] || null : null;
    var credBound = !!(credstore && credstore.boundToManager === true);

    var steps = [];
    var servicesStepN = 0;

    if (hasServices) {
      var servicesDone = allReady && (!credstore || (credBound && bindingActive));
      var when;
      if (!allReady) {
        when = missing.length + " of " + svc.length + " instances missing - pick the plans and click \"Create missing services\" in the card below.";
      } else if (credstore && !credBound) {
        when = "Instances ready. Now click \"Bind to manager\" on the Credential Store row below.";
      } else if (credstore && !bindingActive) {
        when = "Bound. Restart the manager (box below) to activate the binding; in token mode claim a new setup token afterwards.";
      } else {
        when = "";
      }
      servicesStepN = steps.length + 1;
      steps.push({
        id: "services",
        n: servicesStepN,
        title: "Base services",
        why: "Database, app roles and the Credential Store the platform needs, created as service instances in this space.",
        when: when,
        done: servicesDone,
        blocked: "",
        cta: null,
      });
    }

    var afterServices = servicesStepN ? "after step " + servicesStepN : "";

    steps.push({
      id: "mgmt-user",
      n: steps.length + 1,
      title: "Management user",
      why: "A technical CF user stored in the Credential Store. The manager signs in by itself after every restart - no passcode.",
      when: "Needs the Credential Store bound to the manager and active" + (servicesStepN ? " (step " + servicesStepN + ")." : "."),
      done: storedDone,
      blocked: storedDone || bindingActive ? "" : (afterServices || "Credential Store binding not active"),
      cta: "Session & access",
    });

    steps.push({
      id: "platform",
      n: steps.length + 1,
      title: "Platform base (shared connector)",
      why: "The shared backend every L3 app talks to. Installing the first app deploys it automatically.",
      when: hasServices ? "Install refuses while a base service is missing." : "",
      done: platformDone,
      blocked: platformDone || !hasServices || allReady ? "" : afterServices,
      cta: null,
    });

    steps.push({
      id: "figaf-connection",
      n: steps.length + 1,
      title: "Figaf tool connection",
      why: "URL plus API client of the Figaf tool, stored in the Credential Store. Apps list its systems through the connector; no secret is typed into an app.",
      when: "Needs the Credential Store binding active" + (servicesStepN ? " (step " + servicesStepN + ")." : "."),
      done: figafDone,
      blocked: figafDone || bindingActive ? "" : (afterServices || "Credential Store binding not active"),
      cta: "Connections",
    });

    var mgmtStep = steps.filter(function (s) { return s.id === "mgmt-user"; })[0];
    steps.push({
      id: "sso",
      n: steps.length + 1,
      title: "Persistent SSO (IAS sign-in and roles)",
      why: "Replaces the setup token from the logs with SAP IAS sign-in and the FigafManagerAdmin role. Sessions survive restarts and redeploys.",
      when: "Restarts the manager (30-90 s downtime). Do it after step " + mgmtStep.n + ", so the manager signs itself back in. A BTP login lets it assign your role automatically.",
      done: ssoDone,
      blocked: ssoDone || storedDone ? "" : "after step " + mgmtStep.n,
      cta: "Start upgrade",
    });

    var currentSet = false;
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      st.current = !currentSet && !st.done && !st.blocked;
      if (st.current) currentSet = true;
    }

    var doneCount = steps.filter(function (s) { return s.done; }).length;
    return { steps: steps, done: doneCount, total: steps.length };
  }

  if (typeof window !== "undefined") window.figafSetupSteps = figafSetupSteps;
})();
