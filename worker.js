// Servidor de salas do Armada Royale 3D (Cloudflare Workers + Durable Objects, plano gratis)
export class Room {
  constructor(state) { this.state = state; }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ws only', { status: 426 });
    if (this.state.getWebSockets().length >= 8) return new Response('full', { status: 429 });
    const [c, s] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(s);
    s.serializeAttachment({ id });
    s.send(JSON.stringify({ k: 'hi', id }));
    for (const w of this.state.getWebSockets()) {
      if (w === s) continue;
      const a = w.deserializeAttachment();
      if (a && a.p) s.send(JSON.stringify({ k: 's', s: a.p, f: a.id }));
    }
    return new Response(null, { status: 101, webSocket: c });
  }
  webSocketMessage(ws, msg) {
    let d; try { d = JSON.parse(msg); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (d.k === 'pg') { ws.send(JSON.stringify({ k: 'pg', t: d.t })); return; }
    if (d.k === 's') { a.p = d.s; ws.serializeAttachment(a); }
    else if (d.k !== 'e') return;
    d.f = a.id;
    const out = JSON.stringify(d);
    for (const w of this.state.getWebSockets()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    const out = JSON.stringify({ k: 'l', f: a.id });
    for (const w of this.state.getWebSockets()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}
export default {
  fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([a-z0-9]{3,8})$/);
    if (!m) return new Response('Armada Royale relay OK');
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  }
};
