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
    logout: () => ipcRenderer.invoke("btp:logout"),
    listEnvInstances: () => ipcRenderer.invoke("btp:listEnvInstances"),
    listUsers: () => ipcRenderer.invoke("btp:listUsers"),
    assignRole: (user, role) => ipcRenderer.invoke("btp:assignRole", { user, role }),
  },

  cf: {
    loginStart: (apiUrl) => ipcRenderer.invoke("cf:loginStart", { apiUrl }),
    submitPasscode: (code) => ipcRenderer.invoke("cf:submitPasscode", { code }),
    logout: () => ipcRenderer.invoke("cf:logout"),
    targetOrgSpace: () => ipcRenderer.invoke("cf:targetOrgSpace"),
    domains: () => ipcRenderer.invoke("cf:domains"),
    marketplacePostgresql: () => ipcRenderer.invoke("cf:marketplacePostgresql"),
    createService: (args) => ipcRenderer.invoke("cf:createService", args),
    service: (name) => ipcRenderer.invoke("cf:service", { name }),
    pollService: (name) => ipcRenderer.invoke("cf:pollService", { name }),
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
    assignRoleCollectionPreflight: () => ipcRenderer.invoke("xsuaa:assignRoleCollectionPreflight"),
  },

  config: {
    dockerHubLatestBtpTag: () => ipcRenderer.invoke("config:dockerHubLatestBtpTag"),
    dockerHubBtpTags: () => ipcRenderer.invoke("config:dockerHubBtpTags"),
    readVars: () => ipcRenderer.invoke("config:readVars"),
    writeVars: (vars) => ipcRenderer.invoke("config:writeVars", vars),
    deployDir: () => ipcRenderer.invoke("config:deployDir"),
  },

  shell: {
    openPasscodeUrl: (landscape) => ipcRenderer.invoke("shell:openPasscodeUrl", { landscape }),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", { url }),
    readClipboard: () => ipcRenderer.invoke("shell:readClipboard"),
  },

  on,
});
