// Ponte segura entre a tela do CodeView e o app. O site enxerga só window.codeviewNative.
const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Set();
ipcRenderer.on("cv:audio", (_e, pid, data) => { for (const cb of listeners) { try { cb(String(pid), data); } catch {} } });

contextBridge.exposeInMainWorld("codeviewNative", {
  version: 1,
  platform: process.platform,
  listSources: () => ipcRenderer.invoke("cv:sources"),
  listAudioApps: () => ipcRenderer.invoke("cv:audio-apps"),
  select: (sel) => ipcRenderer.invoke("cv:select", sel),
  startAppAudio: (pid) => ipcRenderer.invoke("cv:audio-start", String(pid)),
  stopAppAudio: (pid) => ipcRenderer.invoke("cv:audio-stop", String(pid)),
  // som bruto de um aplicativo: PCM 16 bits, estéreo, 48000 Hz
  onAudio: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
});
