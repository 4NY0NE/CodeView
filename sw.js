// Service worker do CodeView: deixa o app instalável, abre rápido e mostra a tela inicial mesmo sem internet.
// Vídeo e conexão da sala sempre vão pela rede (WebRTC não passa por aqui).
// A CADA versão nova, troque o número abaixo junto com o BUILD do index.html e o version.json.
const VERSION = "2026-11-10.7";
const CACHE = "codeview-" + VERSION;
const SHELL = ["/", "/peerjs.min.js", "/qrcode.min.js", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("codeview-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if(req.method !== "GET" || url.origin !== location.origin) return;
  if(url.pathname.startsWith("/api/") || url.pathname === "/version.json" || url.pathname === "/sw.js") return;

  // páginas (inclui /sala/CODIGO): rede primeiro, para sempre pegar a versão nova; sem rede, usa a cópia guardada
  if(req.mode === "navigate"){
    e.respondWith((async () => {
      try{
        const r = await Promise.race([fetch(req), timeout(5000)]);
        if(r && r.ok){ const c = await caches.open(CACHE); c.put("/", r.clone()); }
        return r;
      }catch(err){
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // arquivos do site: usa o guardado na hora e atualiza em segundo plano
  e.respondWith((async () => {
    const c = await caches.open(CACHE), hit = await c.match(req);
    const net = fetch(req).then(r => { if(r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
