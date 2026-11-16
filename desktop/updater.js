// Atualização automática do app (electron-updater + Releases do GitHub).
// Baixa em segundo plano e instala sozinha quando o app for fechado; a tela também pode pedir "reiniciar agora".
const { app } = require("electron");

let autoUpdater = null;
let state = { state: "idle", version: "", percent: 0 };
let notify = () => {};
let logFn = () => {};
let timer = null;

function set(s) { state = Object.assign({}, state, s); try { notify(state); } catch {} }

function init({ log, onState }) {
  logFn = log || logFn; notify = onState || notify;
  if (!app.isPackaged) { logFn("atualizador desligado (app em desenvolvimento)"); return; }
  try { ({ autoUpdater } = require("electron-updater")); } catch (e) { logFn("atualizador indisponível:", e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;      // se a pessoa fechar o app, ele atualiza ao sair
  autoUpdater.logger = { info: (m) => logFn("upd:", m), warn: (m) => logFn("upd!", m), error: (m) => logFn("upd erro:", m), debug() {} };
  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-available", (i) => set({ state: "downloading", version: i.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => set({ state: "idle" }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(p.percent || 0) }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", version: i.version, percent: 100 }));
  autoUpdater.on("error", (e) => { logFn("upd erro:", e && e.message); if (state.state !== "ready") set({ state: "idle" }); });
  setTimeout(check, 15000);
  timer = setInterval(check, 30 * 60 * 1000);
}
let lastCheck = 0;
// force: pedido manual; sem force, só confere se já passaram 5 minutos da última conferência
function check(force) {
  if (!autoUpdater || state.state === "downloading" || state.state === "ready" || state.state === "checking") return;
  if (force !== true && Date.now() - lastCheck < 5 * 60 * 1000) return;
  lastCheck = Date.now();
  autoUpdater.checkForUpdates().catch((e) => logFn("upd verificar:", e && e.message));
}
function installNow(beforeQuit) {
  if (!autoUpdater || state.state !== "ready") return false;
  try { if (beforeQuit) beforeQuit(); autoUpdater.quitAndInstall(false, true); return true; } catch (e) { logFn("upd instalar:", e.message); return false; }
}
function getState() { return state; }
function stop() { if (timer) clearInterval(timer); }
module.exports = { init, check, installNow, getState, stop };
