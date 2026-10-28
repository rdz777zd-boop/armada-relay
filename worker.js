// Armada Royale 3D relay v3 (Cloudflare Workers + Durable Objects, plano gratis)
// Mudancas v3:
//  - banco: UM registro por chave (d/<colecao>/<id>), sem limite de jogadores; migra o formato antigo sozinho
//  - autenticacao: dono do registro (X-Tok), conta (X-Auth) e segredo do dono (OWNER_KEY, so no servidor)
//  - hash/salt das contas nunca saem do servidor (login em /db/login)
//  - protecao contra __proto__/constructor/prototype, limite de taxa, limite de tamanho
//  - chat em sala propria (/chat), nao ocupa vaga das salas de jogo
//  - ping respondido pelo proprio runtime (sem acordar o Durable Object)
//  - relay sem reparse: menos CPU e menos latencia
// Configure o segredo: wrangler secret put OWNER_KEY   (ou Settings > Variables > Secret, minimo 8 caracteres)

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const TOPS = ['players', 'clans', 'clanstats', 'requests', 'inbox', 'pics'];
const UIDRE = /^[a-z0-9]{12,24}$/;
const ACC = /^ac[0-9a-f]{20}$/;
const IDX = /^(id\d{6,10}|nk[0-9a-f]{24})$/;
const VC = /^vc\d{6,10}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Tok,X-Auth,X-Owner-Key',
  'Access-Control-Max-Age': '86400'
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const enc = new TextEncoder();
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const nz = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export class Room {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.rl = new WeakMap(); this.hits = new Map(); this.cache = {}; this.migP = null; this.pend = 0;
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'q')); } catch {}
  }
  all() { return this.state.getWebSockets(); }
  lim(ip, k, max, win) { return !ip || this.rate(k + ip, max, win); }
  rate(k, max, win) {
    const now = Date.now(); let h = this.hits.get(k);
    if (!h || now - h.t > win) { if (this.hits.size > 4000) this.hits.clear(); h = { t: now, n: 0 }; this.hits.set(k, h); }
    return ++h.n <= max;
  }
  isOwner(req) {
    const k = this.env && this.env.OWNER_KEY;
    return !!k && String(k).length >= 8 && eq(String(k), req.headers.get('X-Owner-Key') || '');
  }

  /* ---------- banco ---------- */
  async migrate() {
    const st = this.state.storage;
    if (await st.get('mig3')) return;
    for (const t of TOPS) {
      if (t === 'pics') continue;
      const old = await st.get(t);
      if (old && typeof old === 'object') {
        const ents = Object.entries(old).filter(([k]) => ID.test(k) && !BAD.has(k));
        for (let i = 0; i < ents.length; i += 100) {
          const b = {};
          for (const [k, v] of ents.slice(i, i + 100)) b['d/' + t + '/' + k] = v;
          await st.put(b);
        }
        await st.delete(t);
      }
    }
    await st.put('mig3', 1);
  }
  async rec(top, id) { return (await this.state.storage.get('d/' + top + '/' + id)) ?? null; }
  async setRec(top, id, v) {
    const k = 'd/' + top + '/' + id;
    if (v === null) await this.state.storage.delete(k); else await this.state.storage.put(k, v);
    const c = this.cache[top];
    if (c) { if (v === null) delete c[id]; else c[id] = v; }
  }
  async delMany(keys) { for (let i = 0; i < keys.length; i += 100) await this.state.storage.delete(keys.slice(i, i + 100)); }
  async list(top) {
    if (this.cache[top]) return this.cache[top];
    const m = await this.state.storage.list({ prefix: 'd/' + top + '/' }), o = {}, n = top.length + 3;
    for (const [k, v] of m) o[k.slice(n)] = v;
    return (this.cache[top] = o);
  }
  async acc(u) {
    u = String(u || '').toLowerCase();
    if (!/^[a-z0-9_]{3,12}$/.test(u)) return null;
    return this.rec('inbox', 'ac' + (await sha('acc:' + u)).slice(0, 20));
  }
  async accAuth(u, h) { const a = await this.acc(u); if (!a) return 'none'; return h && eq(a.h, h) ? 'ok' : 'bad'; }
  async ownsTok(path, tok) {
    if (tok.length < 16) return false;
    const o = await this.state.storage.get('own/' + path);
    return !!o && eq(o, await sha('tok:' + tok));
  }
  pub(top, id, v) {
    if (top === 'inbox' && v && typeof v === 'object' && ACC.test(id)) { const o = { ...v, h: v.h ? '1' : '' }; delete o.s; return o; }
    return v;
  }
  query(v, sp, ob) {
    let f; try { f = JSON.parse(ob); } catch { f = ob; }
    if (typeof f !== 'string' || !ID.test(f)) return v;
    const pj = k => { const s = sp.get(k); if (s === null) return undefined; try { return JSON.parse(s); } catch { return s; } };
    const sa = pj('startAt'), ea = pj('endAt'), lf = +sp.get('limitToFirst') || 0, ll = +sp.get('limitToLast') || 0;
    const val = e => { const x = e[1] && typeof e[1] === 'object' ? e[1][f] : undefined; return x === undefined ? null : x; };
    const cmp = (a, b) => {
      if (a === b) return 0;
      if (a === null) return -1; if (b === null) return 1;
      const ta = typeof a, tb = typeof b;
      if (ta === tb) return a < b ? -1 : a > b ? 1 : 0;
      return ta === 'number' ? -1 : 1;
    };
    let ents = Object.entries(v).map(e => [e, val(e)]);
    if (sa !== undefined) ents = ents.filter(x => cmp(x[1], sa) >= 0);
    if (ea !== undefined) ents = ents.filter(x => cmp(x[1], ea) <= 0);
    ents.sort((a, b) => cmp(a[1], b[1]));
    if (lf) ents = ents.slice(0, lf); else if (ll) ents = ents.slice(-ll);
    return Object.fromEntries(ents.map(x => x[0]));
  }

  async authorize(top, parts, method, body, cr) {
    if (cr.owner) return 0;
    const id = parts[1], path = parts.join('/'), deep = parts.length > 2;
    if (top === 'inbox') {
      const special = ACC.test(id) || IDX.test(id) || VC.test(id) || id === 'banlist' || id === 'verlist';
      if (special && deep) return 403;
      if (!deep) {
        if (id === 'banlist' || id === 'verlist') return 403;
        if (ACC.test(id)) {
          const ex = await this.rec('inbox', id);
          if (method === 'PUT') {
            if (!ex) {
              if (!body || typeof body !== 'object' || typeof body.u !== 'string' || typeof body.h !== 'string' || typeof body.s !== 'string') return 400;
              return id === 'ac' + (await sha('acc:' + body.u.toLowerCase())).slice(0, 20) ? 0 : 400;
            }
            return cr.auth && eq(ex.h || '', cr.auth) ? 0 : 403;
          }
          return !ex || (cr.auth && eq(ex.h || '', cr.auth)) ? 0 : 403;
        }
        if (IDX.test(id)) {
          if (method === 'PUT' && (!body || typeof body.u !== 'string')) return 400;
          const ex = await this.rec('inbox', id);
          if (!ex) return 0;
          return (await this.accAuth(ex.u, cr.auth)) === 'bad' ? 403 : 0;
        }
        if (VC.test(id)) {
          const idr = await this.rec('inbox', 'id' + id.slice(2));
          if (!idr) return 403;
          return (await this.accAuth(idr.u, cr.auth)) === 'ok' ? 0 : 403;
        }
      }
      if (/^cd/.test(id)) {
        const real = (await this.state.storage.get('own/players/' + id)) !== undefined || (await this.rec('players', id)) !== null;
        if (!deep) { if (method === 'PUT') return 403; return (await this.ownsTok('players/' + id, cr.tok)) ? 0 : 403; }
        if (!real) return 403;
      }
    }
    // dono por primeira escrita (TOFU): quem grava primeiro e dono daquele caminho
    if (cr.tok.length < 16) return 401;
    const o = await this.state.storage.get('own/' + path);
    if (o === undefined) { if (method === 'PUT') cr.claim = true; return 0; }
    if (eq(o, await sha('tok:' + cr.tok))) return 0;
    if (method === 'DELETE') {
      if (top === 'inbox' && UIDRE.test(id) && await this.ownsTok('players/' + id, cr.tok)) return 0;
      if ((top === 'requests' || top === 'clanstats') && await this.ownsTok('clans/' + id, cr.tok)) return 0;
    }
    return 403;
  }

  async write(req, parts, top, J, ip) {
    if (!this.lim(ip, 'w', 150, 60000)) return J(null, 429);
    let body = null;
    if (req.method === 'PUT') {
      const t = await req.text();
      if (t.length > 4000) return J(null, 413);
      try { body = JSON.parse(t); } catch { return J(null, 400); }
    }
    const st = this.state.storage, id = parts[1], path = parts.join('/'), method = body === null ? 'DELETE' : 'PUT';
    const cr = { tok: req.headers.get('X-Tok') || '', auth: req.headers.get('X-Auth') || '', owner: this.isOwner(req), claim: false };
    const code = await this.authorize(top, parts, method, body, cr);
    if (code) return J(null, code);
    const ex = await this.rec(top, id);
    let nv;
    if (parts.length === 2) nv = method === 'PUT' ? body : null;
    else {
      if (method === 'DELETE' && ex === null) return J(null);
      nv = ex && typeof ex === 'object' ? ex : {};
      let o = nv;
      for (let i = 2; i < parts.length - 1; i++) { const p = parts[i]; o = o[p] = (own(o, p) && o[p] && typeof o[p] === 'object') ? o[p] : {}; }
      const leaf = parts[parts.length - 1];
      if (method === 'PUT') o[leaf] = body; else delete o[leaf];
    }
    if (top === 'inbox' && parts.length === 2 && ACC.test(id) && method === 'PUT' && ex && ex.h) nv = { ...nv, s: ex.s, h: ex.h };
    if (nv !== null && JSON.stringify(nv).length > 32000) return J(null, 413);
    if (cr.claim) await st.put('own/' + path, await sha('tok:' + cr.tok));
    await this.setRec(top, id, nv);
    if (method === 'DELETE') {
      const ks = ['own/' + path];
      if (parts.length === 2) for (const k of (await st.list({ prefix: 'own/' + path + '/' })).keys()) ks.push(k);
      await this.delMany(ks);
    }
    return J(body);
  }

  async pics(req, parts, u, J, ip) {
    if (req.method === 'GET') {
      if (parts.length === 1) {
        const ids = (u.searchParams.get('ids') || '').split(',').filter(x => ID.test(x) && !BAD.has(x)).slice(0, 20);
        const out = {};
        if (ids.length) {
          const m = await this.state.storage.get(ids.map(i => 'pics:' + i));
          const onlyT = u.searchParams.get('t');
          for (const [k, v] of m) out[k.slice(5)] = onlyT ? ((v && v.t) || 0) : v;
        }
        return J(out);
      }
      return J((await this.state.storage.get('pics:' + parts[1])) ?? null);
    }
    if (parts.length !== 2 || (req.method !== 'PUT' && req.method !== 'DELETE')) return J(null, 400);
    if (!this.lim(ip, 'p', 30, 60000)) return J(null, 429);
    const cr = { tok: req.headers.get('X-Tok') || '', auth: '', owner: this.isOwner(req), claim: false };
    let o = null;
    if (req.method === 'PUT') {
      const t = await req.text();
      if (t.length > 40000) return J(null, 413);
      let b; try { b = JSON.parse(t); } catch { return J(null, 400); }
      const ok = v => typeof v === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+\/]{20,16000}={0,2}$/.test(v);
      o = {};
      if (b && ok(b.a)) o.a = b.a;
      if (b && ok(b.b)) o.b = b.b;
      if (!o.a && !o.b) return J(null, 400);
      o.t = Date.now();
    }
    const code = await this.authorize('pics', parts, req.method, o, cr);
    if (code) return J(null, code);
    if (req.method === 'DELETE') { await this.state.storage.delete(['pics:' + parts[1], 'own/' + parts.join('/')]); return J(null); }
    if (cr.claim) await this.state.storage.put('own/' + parts.join('/'), await sha('tok:' + cr.tok));
    await this.state.storage.put('pics:' + parts[1], o);
    return J(true);
  }

  async db(req) {
    const J = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const u = new URL(req.url), ip = req.headers.get('CF-Connecting-IP') || '';
    const parts = u.pathname.replace(/^\/db/, '').replace(/\.json$/, '').split('/').filter(Boolean), top = parts[0];
    this.migP = this.migP || this.migrate().catch(e => { this.migP = null; throw e; });
    await this.migP;
    // --- endpoints de conta e dono ---
    if (top === 'ownercheck') return J({ ok: this.isOwner(req) });
    if (top === 'salt' && parts.length === 2) {
      if (!this.lim(ip, 's', 30, 60000)) return J(null, 429);
      const a = await this.acc(parts[1]);
      return J(a && a.s ? { s: a.s } : null);
    }
    if ((top === 'login' || top === 'verify') && req.method === 'POST' && parts.length === 1) {
      if (!this.lim(ip, 'l', 12, 60000)) return J(null, 429);
      let b; try { b = JSON.parse(await req.text()); } catch { return J(null, 400); }
      const a = b && typeof b.u === 'string' && typeof b.h === 'string' ? await this.acc(b.u) : null;
      let ok = !!(a && a.h && eq(a.h, b.h));
      if (ok && top === 'verify') { const n = nz(b.n); ok = !!n && (n === nz(a.nk) || n === nz(a.u)); }
      return J({ ok });
    }
    if (parts.length > 4 || parts.some(x => !ID.test(x) || BAD.has(x)) || (top && !TOPS.includes(top))) return J(null, 400);
    if (top === 'pics') return this.pics(req, parts, u, J, ip);
    if (req.method === 'GET') {
      if (!top) return J(null);
      if (parts.length === 1) {
        if (top === 'inbox') return J(null, 403);
        let v = await this.list(top);
        const ob = u.searchParams.get('orderBy');
        if (ob) v = this.query(v, u.searchParams, ob);
        return J(v);
      }
      let v = this.pub(top, parts[1], await this.rec(top, parts[1]));
      for (const p of parts.slice(2)) v = v && typeof v === 'object' && own(v, p) ? v[p] : null;
      return J(v ?? null);
    }
    if (parts.length < 2 || (req.method !== 'PUT' && req.method !== 'DELETE')) return J(null, 400);
    return this.write(req, parts, top, J, ip);
  }
  async where() {
    let colo = '?';
    try { const t = await (await fetch('https://workers.cloudflare.com/cdn-cgi/trace')).text(); const m = t.match(/colo=(\w+)/); if (m) colo = m[1]; } catch {}
    return new Response(JSON.stringify({ room: colo }), { headers: { 'Content-Type': 'application/json' } });
  }

  /* ---------- websockets (salas, chat, lobby) ---------- */
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/where') return this.where();
    if (p.startsWith('/db')) return this.db(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ws only', { status: 426 });
    const lb = p === '/lobby', ch = p === '/chat';
    if (this.all().length >= (lb ? 400 : ch ? 300 : 8)) return new Response('full', { status: 429 });
    const [c, s] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(s);
    s.serializeAttachment({ id, lb: lb ? 1 : 0, ch: ch ? 1 : 0, s: 1, n: '', v: 0 });
    if (lb) s.send(this.rosterStr());
    else {
      s.send(JSON.stringify({ k: 'hi', id }));
      if (!ch) for (const w of this.all()) {
        if (w === s) continue;
        const a = w.deserializeAttachment();
        if (a && a.p) s.send(JSON.stringify({ k: 's', s: a.p, f: a.id }));
      }
    }
    return new Response(null, { status: 101, webSocket: c });
  }
  rosterStr() {
    const l = [];
    for (const w of this.all()) { const a = w.deserializeAttachment(); if (a && a.lb && a.v && a.n) l.push([a.n, a.s]); }
    return JSON.stringify({ k: 'ro', l: l.slice(0, 300) });
  }
  async dirty() { if (this.pend) return; this.pend = 1; await this.state.storage.setAlarm(Date.now() + 1000); }
  async alarm() {
    this.pend = 0;
    const o = this.rosterStr();
    for (const w of this.all()) { try { w.send(o); } catch {} }
  }
  async verify(u, h, n) {
    try {
      const r = await this.env.ROOM.get(this.env.ROOM.idFromName('DB#')).fetch('https://r/db/verify', { method: 'POST', body: JSON.stringify({ u, h, n }) });
      const j = await r.json();
      return !!(j && j.ok);
    } catch { return false; }
  }
  async lobbyMsg(ws, a, msg) {
    let d; try { d = JSON.parse(msg); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.k === 'hi' || d.k === 'st') {
      const n = d.n ? String(d.n).slice(0, 16) : a.n, s = d.s === 3 ? 3 : 1;
      if (n !== a.n || !a.v) {
        const now = Date.now();
        if (!a.v && now - (a.vf || 0) < 15000) return;
        const v = !!n && typeof d.u === 'string' && typeof d.h === 'string' && await this.verify(d.u, d.h, n);
        const b = ws.deserializeAttachment() || a;
        if (!v) { b.vf = now; if (b.v) { b.v = 0; b.n = ''; } ws.serializeAttachment(b); this.dirty(); return; }
        b.v = 1; b.n = n; b.s = s; b.vf = 0; ws.serializeAttachment(b); this.dirty();
        return;
      }
      if (s !== a.s) { a.s = s; ws.serializeAttachment(a); this.dirty(); }
    } else if (d.k === 'iv') {
      if (!a.v || !a.n || !/^[a-z0-9]{3,8}$/.test(String(d.r)) || !this.rate('iv' + a.id, 6, 10000)) return;
      const to = String(d.to || '').toLowerCase(); let ok = 0;
      for (const x of this.all()) {
        if (x === ws) continue;
        const b = x.deserializeAttachment();
        if (b && b.v && b.n && b.n.toLowerCase() === to) { try { x.send(JSON.stringify({ k: 'iv', from: a.n, c: d.r })); ok = 1; } catch {} }
      }
      try { ws.send(JSON.stringify({ k: 'ivr', ok })); } catch {}
    }
  }
  ownerCast(a, msg) {
    if (!this.rate('oa' + a.id, 8, 60000)) return;
    let d; try { d = JSON.parse(msg); } catch { return; }
    const k = this.env && this.env.OWNER_KEY;
    if (!d || !k || String(k).length < 8 || !eq(String(k), String(d.key || ''))) return;
    const c = d.c === 'an' || d.c === 'att' || d.c === 'attx' ? d.c : '';
    if (!c) return;
    const out = JSON.stringify({ k: 'oc', c, x: c === 'an' ? String(d.x || '').slice(0, 120) : '' });
    for (const w of this.all()) { try { w.send(out); } catch {} }
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 16384) return;
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    let r = this.rl.get(ws);
    if (!r || now - r.t > 1000) { r = { t: now, n: 0 }; this.rl.set(ws, r); }
    r.n++;
    if (a.lb) { if (r.n > 20) return; return this.lobbyMsg(ws, a, msg); }
    if (r.n > 400) { if (r.n > 1200) { try { ws.close(1008, 'rate'); } catch {} } return; }
    if (msg.charCodeAt(msg.length - 1) !== 125) return;
    if (msg.startsWith('{"k":"e"')) { this.relay(ws, a, msg); return; }
    if (msg.startsWith('{"k":"s"')) {
      if (!a.ch && (!a.pt || now - a.pt > 1000)) {
        try { const d = JSON.parse(msg); a.p = d.s; a.pt = now; ws.serializeAttachment(a); } catch { return; }
      }
      this.relay(ws, a, msg); return;
    }
    if (a.ch && msg.startsWith('{"k":"oa"')) this.ownerCast(a, msg);
  }
  // o "f" vai no fim: em JSON o ultimo valor vale, entao o cliente nao consegue forjar o remetente
  relay(ws, a, msg) {
    const out = msg.slice(0, -1) + ',"f":"' + a.id + '"}';
    for (const w of this.all()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.lb) { this.dirty(); return; }
    if (a.ch) return;
    const out = JSON.stringify({ k: 'l', f: a.id });
    for (const w of this.all()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}

// Salas, chat e lobby ficam na America do Sul. O banco (DB#) continua no mesmo objeto para nao perder o ranking.
const stub = (env, name) => env.ROOM.get(env.ROOM.idFromName(name), { locationHint: 'sam' });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    if (p === '/where') {
      const code = (u.searchParams.get('room') || 'sala1').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'sala1';
      let room = '?';
      try { room = (await (await stub(env, 'r2#' + code).fetch(req)).json()).room; } catch {}
      return new Response(JSON.stringify({ borda: (req.cf && req.cf.colo) || '?', sala: room }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    if (p.startsWith('/db')) return env.ROOM.get(env.ROOM.idFromName('DB#')).fetch(req);
    if (p === '/lobby') return stub(env, 'LOBBY2#').fetch(req);
    if (p === '/chat') return stub(env, 'CHAT#').fetch(req);
    const m = p.match(/^\/room\/([a-z0-9]{3,8})$/);
    if (!m) return new Response('Armada Royale relay OK');
    return stub(env, 'r2#' + m[1]).fetch(req);
  }
};
