// Entrega servidores STUN/TURN para o CodeView (endereço: /api/ice).
// Os dados secretos ficam nas variáveis de ambiente do Netlify, nunca no código do site.
//
// Opção A (recomendada, grátis até 1 TB/mês): Cloudflare Realtime TURN
//   CF_TURN_KEY_ID      = ID da chave TURN
//   CF_TURN_API_TOKEN   = token da chave TURN
// Opção B: Metered.ca
//   METERED_DOMAIN      = nome do app (a parte antes de .metered.live)
//   METERED_API_KEY     = chave da API
//
// Se nada estiver configurado ou o serviço falhar, responde 204 e o site usa os servidores padrão.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function cloudflare(id, token) {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: 43200 }),
  });
  if (!r.ok) throw new Error("cloudflare " + r.status);
  const j = await r.json();
  let list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
  // a porta 53 costuma ser bloqueada pelos navegadores e só atrasa a conexão
  list = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
  return list;
}

async function metered(domain, key) {
  const r = await fetch(`https://${domain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error("metered " + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

export default async () => {
  const env = (k) => (globalThis.Netlify && Netlify.env ? Netlify.env.get(k) : process.env[k]);
  try {
    let list = [];
    if (env("CF_TURN_KEY_ID") && env("CF_TURN_API_TOKEN")) list = await cloudflare(env("CF_TURN_KEY_ID"), env("CF_TURN_API_TOKEN"));
    else if (env("METERED_DOMAIN") && env("METERED_API_KEY")) list = await metered(env("METERED_DOMAIN"), env("METERED_API_KEY"));
    if (!list.length) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return json({ iceServers: list });
  } catch (e) {
    console.error("ice:", e.message);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/ice" };
