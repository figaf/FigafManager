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
// Order (figaf-l3-l4 decision 0009, 2026-09-03): SECURE ACCESS FIRST.
//   1 Secure access (persistent SSO; creates the XSUAA instance and the
//     Credential Store, binds both, one restart)
//   2 Management user (offered on the gate right after the IAS sign-in)
//   3 Base services (the database; omitted for a v2 release)
//   4 Shared backend (installed with the first app)
//   5 Figaf tool connection
// Everything after step 1 is blocked until step 1 is done: one token, one
// passcode, one restart.
//
// Output: ordered steps in the INSTALL order. Each step:
//   { id, n, title, why, when, done, blocked, current, cta }
//   blocked  = "" or the reason ("after step 1")
//   current  = first step that is neither done nor blocked

(function () {
  "use strict";

  var MANAGER_ROLE = "FigafL3L4-Manager-Admin";

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

    var afterSso = ssoDone ? "" : "after step 1";
    var steps = [];

    steps.push({
      id: "sso",
      n: 1,
      title: "Secure access (persistent SSO)",
      why: "Replaces the setup token from the logs with SAP IAS sign-in and the " + MANAGER_ROLE +
        " role collection. Creates the XSUAA instance (roles of the manager and the apps) and the Credential Store, and binds both to the manager. Sessions survive restarts and redeploys.",
      when: "Needs your Cloud Foundry sign-in (the passcode) - once. Restarts the manager once (30-90 s). For the automatic role assignment add the BTP login first; without it, assign " +
        MANAGER_ROLE + " to yourself in the BTP cockpit before you sign in again.",
      done: ssoDone,
      blocked: "",
      cta: "Start upgrade",
    });

    steps.push({
      id: "mgmt-user",
      n: 2,
      title: "Management user",
      why: "A technical CF user stored in the Credential Store. The manager signs in by itself after every restart - no passcode.",
      when: "Offered on the sign-in gate right after the IAS sign-in. Needs the Credential Store binding active (step 1).",
      done: storedDone,
      blocked: storedDone ? "" : (!ssoDone ? afterSso : (bindingActive ? "" : "Credential Store binding not active")),
      cta: "Session & access",
    });

    var servicesStepN = 0;
    if (hasServices) {
      servicesStepN = steps.length + 1;
      var servicesDone = allReady && (!credstore || (credBound && bindingActive));
      var when;
      if (!allReady) {
        when = missing.length + " of " + svc.length + " instances missing - pick the plans and click \"Create missing services\" in the card below.";
      } else if (credstore && !credBound) {
        when = "Instances ready. Now click \"Bind to manager\" on the Credential Store row below.";
      } else if (credstore && !bindingActive) {
        when = "Bound. Restart the manager (box below) to activate the binding.";
      } else {
        when = "";
      }
      steps.push({
        id: "services",
        n: servicesStepN,
        title: "Base services",
        why: "The database and the other service instances this release needs. Step 1 already created the XSUAA instance and the Credential Store; the database takes minutes.",
        when: when,
        done: servicesDone,
        blocked: servicesDone ? "" : afterSso,
        cta: null,
      });
    }

    steps.push({
      id: "platform",
      n: steps.length + 1,
      title: "Shared backend",
      why: "The shared backend connector every L3 app talks to. Installing the first app deploys it automatically.",
      when: hasServices ? "Install refuses while a base service is missing." : "",
      done: platformDone,
      blocked: platformDone ? "" : (!ssoDone ? afterSso : (hasServices && !allReady ? "after step " + servicesStepN : "")),
      cta: null,
    });

    steps.push({
      id: "figaf-connection",
      n: steps.length + 1,
      title: "Figaf tool connection",
      why: "URL plus API client of the Figaf tool, stored in the Credential Store. Apps list its systems through the connector; no secret is typed into an app.",
      when: "Needs the Credential Store binding active (step 1).",
      done: figafDone,
      blocked: figafDone ? "" : (!ssoDone ? afterSso : (bindingActive ? "" : "Credential Store binding not active")),
      cta: "Connections",
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
