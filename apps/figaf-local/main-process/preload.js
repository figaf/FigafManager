const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();

function on(channel, handler) {
  const wrapped = (_evt, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  set.add(wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    set.delete(wrapped);
  };
}

contextBridge.exposeInMainWorld("figaf", {
  window: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    toggleMax: () => ipcRenderer.invoke("win:toggleMax"),
    close: () => ipcRenderer.invoke("win:close"),
  },

  prereq: {
    whichBtp: () => ipcRenderer.invoke("prereq:whichBtp"),
    whichCf: () => ipcRenderer.invoke("prereq:whichCf"),
    dockerHub: () => ipcRenderer.invoke("prereq:dockerHub"),
    disk: () => ipcRenderer.invoke("prereq:disk"),
    getCliPaths: () => ipcRenderer.invoke("prereq:getCliPaths"),
    clearCliPath: (cli) => ipcRenderer.invoke("prereq:clearCliPath", { cli }),
    installBtp: () => ipcRenderer.invoke("prereq:installBtp"),
    installCf: () => ipcRenderer.invoke("prereq:installCf"),
    openBtpDownloadPage: () => ipcRenderer.invoke("prereq:openBtpDownloadPage"),
    locateCli: (cli) => ipcRenderer.invoke("prereq:locateCli", { cli }),
  },

  btp: {
    loginStart: () => ipcRenderer.invoke("btp:loginStart"),
    submitChoice: (choice) => ipcRenderer.invoke("btp:submitChoice", { choice }),
    cancelLogin: () => ipcRenderer.invoke("btp:cancelLogin"),
    selectGlobalAccount: (subdomain) => ipcRenderer.invoke("btp:selectGlobalAccount", { subdomain }),
    selectSubaccount: (guid) => ipcRenderer.invoke("btp:selectSubaccount", { guid }),
    logout: () => ipcRenderer.invoke("btp:logout"),
    listEnvInstances: () => ipcRenderer.invoke("btp:listEnvInstances"),
    listUsers: () => ipcRenderer.invoke("btp:listUsers"),
    assignRole: (user, role) => ipcRenderer.invoke("btp:assignRole", { user, role }),
  },

  cf: {
    loginStart: (apiUrl) => ipcRenderer.invoke("cf:loginStart", { apiUrl }),
    submitPasscode: (code) => ipcRenderer.invoke("cf:submitPasscode", { code }),
    selectOrg: (index) => ipcRenderer.invoke("cf:selectOrg", { index }),
    selectSpace: (index) => ipcRenderer.invoke("cf:selectSpace", { index }),
    logout: () => ipcRenderer.invoke("cf:logout"),
    targetOrgSpace: () => ipcRenderer.invoke("cf:targetOrgSpace"),
    domains: () => ipcRenderer.invoke("cf:domains"),
    marketplacePostgresql: () => ipcRenderer.invoke("cf:marketplacePostgresql"),
    createService: (args) => ipcRenderer.invoke("cf:createService", args),
    service: (name) => ipcRenderer.invoke("cf:service", { name }),
    pollService: (name) => ipcRenderer.invoke("cf:pollService", { name }),
    createServiceKey: (a) => ipcRenderer.invoke("cf:createServiceKey", a),
    serviceKey:       (a) => ipcRenderer.invoke("cf:serviceKey", a),
    marketplaceCheck: (a) => ipcRenderer.invoke("cf:marketplaceCheck", a),
    push: () => ipcRenderer.invoke("cf:push"),
    // v2 XSUAA upgrade (no-ops on desktop — the handlers return
    // "not available in desktop mode" but we expose the surface to keep the
    // window.figaf shape symmetric between the two apps).
    createXsuaa:           () => ipcRenderer.invoke("cf:createXsuaa"),
    pushManagerApprouter:  () => ipcRenderer.invoke("cf:pushManagerApprouter"),
    mapRoute:              (a) => ipcRenderer.invoke("cf:mapRoute", a),
    unmapRoute:            (a) => ipcRenderer.invoke("cf:unmapRoute", a),
    restage:               (a) => ipcRenderer.invoke("cf:restage", a),
    uninstallManager:      (a) => ipcRenderer.invoke("cf:uninstallManager", a || {}),
  },

  xsuaa: {
    upgradeStatus:                 () => ipcRenderer.invoke("xsuaa:upgradeStatus"),
    assignRoleCollection:          (role) => ipcRenderer.invoke("xsuaa:assignRoleCollection", { role }),
    assignRoleCollectionPreflight: () => ipcRenderer.invoke("xsuaa:assignRoleCollectionPreflight"),
  },

  // Update Figaf Tool — hosted-only flow. Handlers gate on host.isHosted and
  // return a safe error in desktop mode; surface is exposed here for shape
  // parity with the cloud client.
  update: {
    resumeStatus:     () => ipcRenderer.invoke("update:resumeStatus"),
    detectDeployment: (a) => ipcRenderer.invoke("update:detectDeployment", a || {}),
    readCurrentConfig: (a) => ipcRenderer.invoke("update:readCurrentConfig", a || {}),
    begin:            (a) => ipcRenderer.invoke("update:begin", a || {}),
    clear:            () => ipcRenderer.invoke("update:clear"),
    writeVars:        (a) => ipcRenderer.invoke("update:writeVars", a || {}),
    updateXsuaa:      (a) => ipcRenderer.invoke("update:updateXsuaa", a || {}),
    deleteApps:       (a) => ipcRenderer.invoke("update:deleteApps", a || {}),
    pushApp:          (a) => ipcRenderer.invoke("update:pushApp", a || {}),
    verify:           (a) => ipcRenderer.invoke("update:verify", a || {}),
  },

  connect: {
    templatePath: (name) => ipcRenderer.invoke("connect:templatePath", { name }),
    trustConfigUrl: () => ipcRenderer.invoke("connect:trustConfigUrl"),
    resolveIdpOrigin: (idpName) => ipcRenderer.invoke("connect:resolveIdpOrigin", { idpName }),
    assignPiRole: (a) => ipcRenderer.invoke("connect:assignPiRole", a || {}),
    samlSsoUrl: () => ipcRenderer.invoke("connect:samlSsoUrl"),
  },

  config: {
    dockerHubLatestBtpTag: () => ipcRenderer.invoke("config:dockerHubLatestBtpTag"),
    dockerHubBtpTags: () => ipcRenderer.invoke("config:dockerHubBtpTags"),
    readVars: () => ipcRenderer.invoke("config:readVars"),
    writeVars: (vars) => ipcRenderer.invoke("config:writeVars", vars),
    readDbConfig: () => ipcRenderer.invoke("config:readDbConfig"),
    writeDbConfig: (payload) => ipcRenderer.invoke("config:writeDbConfig", payload),
    dbSchema: (payload) => ipcRenderer.invoke("config:dbSchema", payload),
    deployDir: () => ipcRenderer.invoke("config:deployDir"),
  },

  shell: {
    openPasscodeUrl: (landscape) => ipcRenderer.invoke("shell:openPasscodeUrl", { landscape }),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", { url }),
    readClipboard: () => ipcRenderer.invoke("shell:readClipboard"),
    writeClipboard:  (text) => ipcRenderer.invoke("shell:writeClipboard", { text }),
  },

  on,
});
