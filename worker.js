// Armada Royale 3D: salas + lobby online + fila de partida (Cloudflare Workers + Durable Objects, plano gratis)
// Versao com salas criadas na America do Sul (locationHint 'sam') e menos gravacoes de estado.
export class Room {
  constructor(state) { this.state = state; }
  all() { return this.state.getWebSockets(); }
  async db(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    const J = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const u = new URL(req.url), parts = u.pathname.replace(/^\/db/, '').replace(/\.json$/, '').split('/').filter(Boolean), top = parts[0];
    if (parts.length > 4 || parts.some(x => !/^[A-Za-z0-9_-]{1,40}$/.test(x)) || (top && !['players', 'clans', 'clanstats', 'requests', 'inbox'].includes(top))) return J(null, 400);
    if (req.method === 'GET') {
      if (!top) return J(null);
      let v = (await this.state.storage.get(top)) ?? null;
      for (const p of parts.slice(1)) v = v && typeof v === 'object' ? (v[p] ?? null) : null;
      const ob = u.searchParams.get('orderBy'), lim = +u.searchParams.get('limitToLast');
      if (ob && lim && v && typeof v === 'object' && parts.length === 1) {
        let f = ''; try { f = JSON.parse(ob); } catch {}
        v = Object.fromEntries(Object.entries(v).sort((a, b) => (+(a[1] && a[1][f]) || 0) - (+(b[1] && b[1][f]) || 0)).slice(-lim));
      }
      return J(v);
    }
    if (parts.length < 2 || (req.method !== 'PUT' && req.method !== 'DELETE')) return J(null, 400);
    let body = null;
    if (req.method === 'PUT') { const t = await req.text(); if (t.length > 4000) return J(null, 413); try { body = JSON.parse(t); } catch { return J(null, 400); } }
    const root = (await this.state.storage.get(top)) || {};
    let o = root;
    for (let i = 1; i < parts.length - 1; i++) o = o[parts[i]] = (o[parts[i]] && typeof o[parts[i]] === 'object') ? o[parts[i]] : {};
    const leaf = parts[parts.length - 1];
    if (req.method === 'PUT') o[leaf] = body; else delete o[leaf];
    await this.state.storage.put(top, root);
    return J(body);
  }
  async where() {
    let colo = '?';
    try { const t = await (await fetch('https://workers.cloudflare.com/cdn-cgi/trace')).text(); const m = t.match(/colo=(\w+)/); if (m) colo = m[1]; } catch {}
    return new Response(JSON.stringify({ room: colo }), { headers: { 'Content-Type': 'application/json' } });
  }
  async fetch(req) {
    if (new URL(req.url).pathname === '/where') return this.where();
    if (new URL(req.url).pathname.startsWith('/db')) return this.db(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ws only', { status: 426 });
    const lb = new URL(req.url).pathname === '/lobby';
    if (!lb && this.all().length >= 8) return new Response('full', { status: 429 });
    const [c, s] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(s);
    s.serializeAttachment({ id, lb: lb ? 1 : 0, s: 1, n: '' });
    if (!lb) {
      s.send(JSON.stringify({ k: 'hi', id }));
      for (const w of this.all()) {
        if (w === s) continue;
        const a = w.deserializeAttachment();
        if (a && a.p) s.send(JSON.stringify({ k: 's', s: a.p, f: a.id }));
      }
    }
    return new Response(null, { status: 101, webSocket: c });
  }
  roster(ex) {
    const l = [];
    for (const w of this.all()) { if (w === ex) continue; const a = w.deserializeAttachment(); if (a && a.lb && a.n) l.push([a.n, a.s]); }
    const o = JSON.stringify({ k: 'ro', l: l.slice(0, 300) });
    for (const w of this.all()) if (w !== ex) { try { w.send(o); } catch {} }
  }
  async webSocketMessage(ws, msg) {
    let d; try { d = JSON.parse(msg); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (a.lb) {
      if (d.k === 'hi' || d.k === 'st') {
        const n = d.n ? String(d.n).slice(0, 16) : a.n, s = d.s === 3 ? 3 : 1;
        if (n !== a.n || s !== a.s) { a.n = n; a.s = s; ws.serializeAttachment(a); this.roster(); }
      } else if (d.k === 'q') {
        a.q = [1, 2, 4].includes(d.m) ? d.m : 1; a.qt = Date.now(); ws.serializeAttachment(a);
        await this.state.storage.setAlarm(Date.now() + 1500);
      } else if (d.k === 'qc') { a.q = 0; ws.serializeAttachment(a); }
      else if (d.k === 'iv' && a.n && /^[a-z0-9]{3,8}$/.test(d.r)) {
        const to = String(d.to || '').toLowerCase(); let ok = 0;
        for (const x of this.all()) { const b = x.deserializeAttachment(); if (x !== ws && b && b.lb && b.n && b.n.toLowerCase() === to) { try { x.send(JSON.stringify({ k: 'iv', from: a.n, c: d.r })); ok = 1; } catch {} } }
        ws.send(JSON.stringify({ k: 'ivr', ok }));
      }
      return;
    }
    if (d.k === 'pg') { ws.send(JSON.stringify({ k: 'pg', t: d.t })); return; }
    if (d.k === 's') {
      // guarda o estado para quem entra depois, no maximo 1x por segundo (o repasse aos outros continua em tempo real)
      const t = Date.now();
      if (!a.pt || t - a.pt > 1000) { a.p = d.s; a.pt = t; ws.serializeAttachment(a); }
    }
    else if (d.k !== 'e') return;
    d.f = a.id;
    const out = JSON.stringify(d);
    for (const w of this.all()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  async alarm() {
    const now = Date.now(); let pend = 0;
    for (const m of [1, 2, 4]) {
      const L = this.all().filter(w => { const a = w.deserializeAttachment(); return a && a.lb && a.q === m; })
        .sort((x, y) => x.deserializeAttachment().qt - y.deserializeAttachment().qt);
      if (!L.length) continue;
      const wait = now - L[0].deserializeAttachment().qt;
      if (L.length >= 8 || (L.length >= 2 && wait >= 8000) || wait >= 15000) {
        const g = L.slice(0, 8), c = 'mm' + Math.random().toString(36).slice(2, 7).padEnd(5, '0');
        for (const w of g) { const a = w.deserializeAttachment(); a.q = 0; w.serializeAttachment(a); try { w.send(JSON.stringify({ k: 'mm', c, m, n: g.length })); } catch {} }
        if (L.length > 8) pend = 1;
      } else pend = 1;
    }
    if (pend) await this.state.storage.setAlarm(Date.now() + 1500);
  }
  webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.lb) { this.roster(ws); return; }
    const out = JSON.stringify({ k: 'l', f: a.id });
    for (const w of this.all()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}

// Salas e lobby novos, pedidos na America do Sul. O banco (DB#) continua igual para nao perder o ranking.
const stub = (env, name) => env.ROOM.get(env.ROOM.idFromName(name), { locationHint: 'sam' });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    if (p === '/where') {
      // diagnostico: abra https://SEU-WORKER/where e veja em qual datacenter estao a borda (perto de voce) e a sala
      const code = (u.searchParams.get('room') || 'sala1').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'sala1';
      let room = '?';
      try { room = (await (await stub(env, 'r2#' + code).fetch(req)).json()).room; } catch {}
      return new Response(JSON.stringify({ borda: (req.cf && req.cf.colo) || '?', sala: room }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    if (p.startsWith('/db')) return env.ROOM.get(env.ROOM.idFromName('DB#')).fetch(req);
    if (p === '/lobby') return stub(env, 'LOBBY2#').fetch(req);
    const m = p.match(/^\/room\/([a-z0-9]{3,8})$/);
    if (!m) return new Response('Armada Royale relay OK');
    return stub(env, 'r2#' + m[1]).fetch(req);
  }
};
