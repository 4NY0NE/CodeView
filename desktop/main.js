// CodeView para Windows.
// Abre o site do CodeView numa janela própria e dá a ele o que o navegador não tem:
// lista de telas/janelas, som do computador e som POR APLICATIVO (captura de áudio por processo do Windows).
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Menu, Tray, nativeImage, dialog, powerSaveBlocker } = require("electron");
const path = require("path");
const audioWatch = require("./audiowatch");

const SITE = process.env.CODEVIEW_URL || "https://scodeview.netlify.app";
const SITE_ORIGIN = new URL(SITE).origin;
const IS_WIN = process.platform === "win32";

// ---- som por aplicativo (só Windows) ----
let loopback = null;
if (IS_WIN) {
  try {
    loopback = require("application-loopback");
    if (app.isPackaged) {
      loopback.setExecutablesRoot(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "application-loopback", "bin"));
    }
  } catch (e) { console.error("Som por aplicativo indisponível:", e.message); }
}

let win = null;
let tray = null;
let quitting = false;
let inRoom = false;              // a tela do CodeView avisa quando está numa sala (mantém o app vivo em segundo plano)
let keepAwake = null;            // id do powerSaveBlocker enquanto estiver numa sala
let hintShown = false;
const START_HIDDEN = process.argv.includes("--hidden");
let selection = null;            // { sourceId, systemAudio } escolhido na tela do CodeView
const captures = new Set();      // PIDs com captura de som em andamento

// convite: codeview://sala/ABC123 (só 6 letras/números; qualquer outra coisa é ignorada)
function inviteFromArgs(args) {
  for (const a of args || []) {
    const m = /^codeview:\/\/(?:sala|join)\/([A-Za-z0-9]{6})\/?$/i.exec(String(a));
    if (m) return m[1].toUpperCase();
  }
  return "";
}
function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
async function openInvite(code) {
  if (!code) return;
  if (!win) { createWindow(code); return; }
  showWindow();
  if (inRoom) { // não derruba a sala atual sem perguntar
    const r = await dialog.showMessageBox(win, { type: "question", buttons: ["Entrar na nova sala", "Ficar onde estou"], defaultId: 1, cancelId: 1,
      title: "CodeView", message: "Entrar na sala " + code + "?", detail: "Você vai sair da sala em que está agora." });
    if (r.response !== 0) return;
  }
  win.loadURL(SITE + "/sala/" + code);
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else app.on("second-instance", (_e, argv) => {
  const code = inviteFromArgs(argv);
  if (code) openInvite(code); else showWindow();
});
// protocolo codeview:// (o instalador também registra; isto cobre o app rodando sem instalar)
try {
  if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient("codeview", process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient("codeview");
} catch {}

function sameOrigin(url) { try { return new URL(url).origin === SITE_ORIGIN; } catch { return false; } }

function createWindow(inviteCode) {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    show: !(START_HIDDEN && !inviteCode),
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: "#0e1016", title: "CodeView", autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false, // minimizado ou na bandeja a transmissão e o som não podem ficar lentos
    },
  });
  win.loadURL(inviteCode ? SITE + "/sala/" + inviteCode : SITE);
  win.webContents.on("did-start-navigation", (e, _url, inPlace, mainFrame) => {
    const main = e && e.isMainFrame !== undefined ? e.isMainFrame : mainFrame, same = e && e.isSameDocument !== undefined ? e.isSameDocument : inPlace;
    if (main && !same) setInRoom(false);
  });
  // links externos abrem no navegador do sistema; o app só navega dentro do CodeView
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !sameOrigin(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!sameOrigin(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  // fechar a janela dentro de uma sala não tira você dela: o app continua na bandeja
  win.on("close", (e) => {
    if (quitting || !inRoom) return;
    e.preventDefault(); win.hide();
    if (!hintShown && tray && process.platform === "win32") {
      hintShown = true;
      try { tray.displayBalloon({ title: "CodeView continua aberto", content: "Você segue na sala, em segundo plano. Para fechar de vez, clique com o botão direito no ícone e escolha Sair.", iconType: "info" }); } catch {}
    }
  });
  win.on("closed", () => { win = null; stopAllCaptures(); audioWatch.stop(); });
}

function setInRoom(v) {
  v = !!v;
  if (v === inRoom) return;
  inRoom = v;
  if (v && keepAwake === null) { try { keepAwake = powerSaveBlocker.start("prevent-app-suspension"); } catch {} }
  if (!v && keepAwake !== null) { try { powerSaveBlocker.stop(keepAwake); } catch {} keepAwake = null; }
  updateTray();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
    tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
    tray.setToolTip("CodeView");
    tray.on("click", showWindow);
    updateTray();
  } catch (e) { console.error("Bandeja indisponível:", e.message); }
}
function updateTray() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setToolTip(inRoom ? "CodeView — você está em uma sala" : "CodeView");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir o CodeView", click: showWindow },
    { type: "separator" },
    { label: "Abrir junto com o Windows (em segundo plano)", type: "checkbox", checked: login,
      click: (item) => { try { app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }); } catch {} } },
    { type: "separator" },
    { label: "Sair do CodeView", click: () => { quitting = true; app.quit(); } },
  ]));
}

function stopAllCaptures() {
  if (!loopback) return;
  for (const pid of [...captures]) { try { loopback.stopAudioCapture(String(pid)); } catch {} }
  captures.clear();
}

// ---- permissões: só o próprio site e só o necessário ----
function setupPermissions() {
  const ok = new Set(["media", "display-capture", "fullscreen", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(ok.has(permission) && sameOrigin(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => ok.has(permission) && sameOrigin(origin));
  // getDisplayMedia: quem escolhe a fonte é a tela do CodeView (via IPC); aqui só entregamos o que foi escolhido
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!request.securityOrigin || !sameOrigin(request.securityOrigin) || !selection) return callback(null);
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find(s => s.id === selection.sourceId);
      if (!src) return callback(null);
      const streams = { video: src };
      if (selection.systemAudio && IS_WIN && request.audioRequested) streams.audio = "loopback";
      callback(streams);
    } catch (e) { callback(null); }
    finally { selection = null; }
  });
}

// ---- IPC usado pela tela do CodeView ----
function registerIpc() {
  const fromSite = (e) => e.senderFrame && sameOrigin(e.senderFrame.url);

  // ícone de cada janela: converte uma vez só (toDataURL a cada leitura pesa e causa travadinha)
  const iconCache = new Map();
  const iconOf = (s) => {
    if (iconCache.has(s.id)) return iconCache.get(s.id);
    const v = s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : "";
    if (iconCache.size > 300) iconCache.clear();
    iconCache.set(s.id, v); return v;
  };

  ipcMain.handle("cv:sources", async (e) => {
    if (!fromSite(e)) return [];
    const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 256, height: 144 }, fetchWindowIcons: true });
    let own = "";
    try { if (win) own = win.getNativeWindowHandle().readBigUInt64LE(0).toString(); } catch {}
    return list
      .filter(s => !(own && s.id.startsWith("window:" + own + ":")))
      .map(s => ({
        id: s.id, name: s.name, kind: s.id.startsWith("screen:") ? "screen" : "window",
        hwnd: s.id.startsWith("window:") ? s.id.split(":")[1] : "",
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : "",
        icon: iconOf(s),
      }));
  });

  let appsCache = { at: 0, p: null };
  ipcMain.handle("cv:audio-apps", async (e) => {
    if (!fromSite(e) || !loopback) return [];
    if (appsCache.p && Date.now() - appsCache.at < 3000) return appsCache.p;
    appsCache = { at: Date.now(), p: listApps() };
    return appsCache.p;
  });
  async function listApps() {
    const rows = await loopback.getActiveWindowProcessIds();
    const seen = new Set(), out = [];
    for (const r of rows) {
      const pid = String(r.processId);
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid || seen.has(pid) || !String(r.title || "").trim()) continue;
      seen.add(pid);
      out.push({ pid, hwnd: String(r.hwnd), title: String(r.title).slice(0, 120), active: null });
    }
    // quem está emitindo som agora: a sessão de áudio é do processo que toca (muitas vezes um filho do que tem a janela),
    // então sobe pela cadeia de pais até achar um processo com janela
    const snap = await audioWatch.snapshot();
    if (snap) {
      const byPid = new Map(out.map(o => [o.pid, o]));
      for (const o of out) o.active = false;
      for (const s of snap.sessions) {
        if (!(s.state === 1 || s.peak > 0)) continue;
        const hit = [s.pid, ...s.chain].find(p => byPid.has(p));
        if (hit) byPid.get(hit).active = true;
      }
    }
    return out;
  }

  ipcMain.on("cv:room-state", (e, st) => {
    if (!fromSite(e) || !st || typeof st !== "object") return;
    setInRoom(st.inRoom === true);
  });

  ipcMain.handle("cv:select", (e, sel) => {
    if (!fromSite(e) || !sel || typeof sel.sourceId !== "string") return false;
    selection = { sourceId: sel.sourceId, systemAudio: !!sel.systemAudio };
    return true;
  });

  ipcMain.handle("cv:audio-start", (e, pid) => {
    if (!fromSite(e) || !loopback) return false;
    pid = String(pid);
    if (!/^\d+$/.test(pid) || captures.has(pid)) return captures.has(pid);
    try {
      loopback.startAudioCapture(pid, {
        onData: (chunk) => { if (win && !win.isDestroyed()) win.webContents.send("cv:audio", pid, chunk); },
      });
      captures.add(pid);
      return true;
    } catch (err) { console.error("startAudioCapture:", err.message); return false; }
  });

  ipcMain.handle("cv:audio-stop", (e, pid) => {
    if (!fromSite(e) || !loopback) return false;
    pid = String(pid);
    captures.delete(pid);
    try { return loopback.stopAudioCapture(pid); } catch { return false; }
  });
}

app.whenReady().then(() => { setupPermissions(); registerIpc(); createTray(); createWindow(inviteFromArgs(process.argv)); });
app.on("window-all-closed", () => { stopAllCaptures(); app.quit(); });
app.on("before-quit", () => { quitting = true; stopAllCaptures(); });
app.on("before-quit", () => audioWatch.stop());
