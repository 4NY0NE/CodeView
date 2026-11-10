// CodeView para Windows.
// Abre o site do CodeView numa janela própria e dá a ele o que o navegador não tem:
// lista de telas/janelas, som do computador e som POR APLICATIVO (captura de áudio por processo do Windows).
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Menu } = require("electron");
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
let selection = null;            // { sourceId, systemAudio } escolhido na tela do CodeView
const captures = new Set();      // PIDs com captura de som em andamento

if (!app.requestSingleInstanceLock()) { app.quit(); }
else app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function sameOrigin(url) { try { return new URL(url).origin === SITE_ORIGIN; } catch { return false; } }

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: "#0e1016", title: "CodeView", autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadURL(SITE);
  // links externos abrem no navegador do sistema; o app só navega dentro do CodeView
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !sameOrigin(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!sameOrigin(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.on("closed", () => { win = null; stopAllCaptures(); audioWatch.stop(); });
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
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : "",
      }));
  });

  ipcMain.handle("cv:audio-apps", async (e) => {
    if (!fromSite(e) || !loopback) return [];
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

app.whenReady().then(() => { setupPermissions(); registerIpc(); createWindow(); });
app.on("window-all-closed", () => { stopAllCaptures(); app.quit(); });
app.on("before-quit", stopAllCaptures);
app.on("before-quit", () => audioWatch.stop());
