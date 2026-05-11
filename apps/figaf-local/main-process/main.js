const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const bridge = require("./bridge");

const isDev = !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    backgroundColor: "#0f172a",
    show: false,
    icon: path.join(__dirname, "..", "figaf-logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "..", "installer", "index.html"));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(() => {
  bridge.register({ ipcMain, getWindow: () => mainWindow, shell });
  registerWindowControls();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  bridge.dispose();
  if (process.platform !== "darwin") app.quit();
});

function registerWindowControls() {
  ipcMain.handle("win:minimize", () => mainWindow?.minimize());
  ipcMain.handle("win:toggleMax", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("win:close", () => mainWindow?.close());
}
