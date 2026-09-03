"use strict";
const orchestrator = require("./orchestrator");
const auditLog = require("./audit-log");

module.exports = {
  ...orchestrator,
  createAuditLogger: auditLog.createAuditLogger,
  AUDIT_LEVELS: auditLog.LEVELS,
  // One XSUAA instance for the manager and the apps (decision 0009).
  managerXsuaa: require("./manager-xsuaa"),
};
