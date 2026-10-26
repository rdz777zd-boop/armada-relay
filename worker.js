// Armada Royale 3D: salas + lobby online + fila de partida (Cloudflare Workers + Durable Objects, plano gratis)
export class Room {
  constructor(state) { this.state = state; }
  all() { return this.state.getWebSockets(); }
  async fetch(req) {
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
      return;
    }
    if (d.k === 'pg') { ws.send(JSON.stringify({ k: 'pg', t: d.t })); return; }
    if (d.k === 's') { a.p = d.s; ws.serializeAttachment(a); }
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
export default {
  fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/lobby') return env.ROOM.get(env.ROOM.idFromName('LOBBY#')).fetch(req);
    const m = p.match(/^\/room\/([a-z0-9]{3,8})$/);
    if (!m) return new Response('Armada Royale relay OK');
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  }
};
