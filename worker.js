// Armada Royale 3D: salas + lobby online + fila de partida (Cloudflare Workers + Durable Objects, plano gratis)
// Versao com salas criadas na America do Sul (locationHint 'sam') e menos gravacoes de estado.
// v2: rota /db/pics para foto e banner dos jogadores (o limite de 4000 caracteres recusava as imagens).
// v3: servidor MCP somente leitura em /mcp (ranking e busca de jogador).
// v4: novas ferramentas MCP: health_check, list_players, compare_players, get_averages.
export class Room {
  constructor(state, env) { this.state = state; this.env = env || {}; }
  all() { return this.state.getWebSockets(); }
  async pics(req, parts, u, J) {
    const ID = /^[A-Za-z0-9_-]{1,40}$/;
    if (req.method === 'GET') {
      if (parts.length === 1) {
        const ids = (u.searchParams.get('ids') || '').split(',').filter(x => ID.test(x)).slice(0, 20);
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
    if (parts.length !== 2) return J(null, 400);
    if (req.method === 'DELETE') { await this.state.storage.delete('pics:' + parts[1]); return J(null); }
    const t = await req.text();
    if (t.length > 40000) return J(null, 413);
    let b; try { b = JSON.parse(t); } catch { return J(null, 400); }
    const ok = v => typeof v === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+\/]{20,16000}={0,2}$/.test(v);
    const o = {};
    if (b && ok(b.a)) o.a = b.a;
    if (b && ok(b.b)) o.b = b.b;
    if (!o.a && !o.b) return J(null, 400);
    o.t = Date.now();
    await this.state.storage.put('pics:' + parts[1], o);
    return J(true);
  }
  async db(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Arr-Dev, X-Arr-Acc' };
    const J = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const u = new URL(req.url), parts = u.pathname.replace(/^\/db/, '').replace(/\.json$/, '').split('/').filter(Boolean), top = parts[0];
    if (!this.ep) await this.state.blockConcurrencyWhile(() => 0);
    if (parts.length > 4 || parts.some(x => !/^[A-Za-z0-9_-]{1,40}$/.test(x)) || (top && !['players', 'clans', 'clanstats', 'requests', 'inbox', 'pics'].includes(top))) return J(null, 400);
    if (top === 'pics') return this.pics(req, parts, u, J);
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
    // protecao opcional: so ativa se a variavel ENFORCE=1 estiver definida no Worker (padrao desligado, nada muda)
    if (this.env.ENFORCE === '1') {
      const g = await this.guard(req, top, parts);
      if (!g.ok) return J(null, 403);
      if (top === 'players' && req.method === 'PUT' && !this.statsOk(root, parts, body)) return J(null, 409);
    }
    let o = root;
    for (let i = 1; i < parts.length - 1; i++) o = o[parts[i]] = (o[parts[i]] && typeof o[parts[i]] === 'object') ? o[parts[i]] : {};
    const leaf = parts[parts.length - 1];
    if (req.method === 'PUT') o[leaf] = body; else delete o[leaf];
    await this.state.storage.put(top, root);
    return J(body);
  }
  async sha(t) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  // Donos de registros (guarda so o hash do token):
  //  - players/<uid> e pics/<uid> (uid do aparelho): cabecalho X-Arr-Dev
  //  - contas e indices da conta em inbox (ac, nk, id, vc): cabecalho X-Arr-Acc (derivado da senha)
  // Registro sem dono continua aceitando gravacao (contas antigas); sem token nao reserva nada.
  async guard(req, top, parts) {
    const id = parts[1] || '';
    let rk = '', hd = '';
    if ((top === 'players' || top === 'pics') && /^[a-z0-9]{12,24}$/.test(id)) { rk = top + '/' + id; hd = 'X-Arr-Dev'; }
    else if (top === 'inbox' && /^(ac[0-9a-f]{20}|nk[0-9a-f]{24}|id\d{6,10}|vc\d{6,10})$/.test(id)) { rk = 'inbox/' + id; hd = 'X-Arr-Acc'; }
    if (!rk) return { ok: true };
    const tok = req.headers.get(hd) || '';
    const has = /^[a-f0-9]{64}$/.test(tok);
    const stored = await this.state.storage.get('tk:' + rk);
    if (stored) return { ok: has && (await this.sha(tok)) === stored, rk };
    if (has) await this.state.storage.put('tk:' + rk, await this.sha(tok));
    return { ok: true, rk };
  }
  // anti-trapaca simples: recusa saltos absurdos nas estatisticas em uma unica gravacao
  // (nao e autenticacao de verdade; ajuste os limites abaixo se o jogo gravar mais de uma partida por vez)
  statsOk(root, parts, body) {
    const MAX = { k: 100, w: 5, g: 5, rw: 5, rg: 5, rp: 200 };
    const check = (oldO, newO) => {
      if (!newO || typeof newO !== 'object') return true;
      for (const f in MAX) {
        if (newO[f] === undefined) continue;
        if (typeof newO[f] !== 'number' || !isFinite(newO[f])) return false;
        const old = oldO && typeof oldO[f] === 'number' ? oldO[f] : null;
        if (old !== null && newO[f] - old > MAX[f]) return false;
      }
      return true;
    };
    const rec = root[parts[1]];
    if (parts.length === 2) return check(rec, body);
    if (parts.length === 3 && MAX[parts[2]] !== undefined) {
      if (typeof body !== 'number' || !isFinite(body)) return false;
      const old = rec && typeof rec[parts[2]] === 'number' ? rec[parts[2]] : null;
      return old === null || body - old <= MAX[parts[2]];
    }
    return true;
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
    if (a.lb) { this.roster(ws); if (a.rm) this.rooms(ws); return; }
    const out = JSON.stringify({ k: 'l', f: a.id });
    for (const w of this.all()) if (w !== ws) { try { w.send(out); } catch {} }
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}

// ============================================================
// Servidor MCP (somente leitura). URL no Claude: https://armada-relay.rdz777zd.workers.dev/mcp
// ============================================================
const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
};

const num = (x) => (typeof x === 'number' ? x : 0);
const taxa = (v, p) => (p > 0 ? Math.round((v / p) * 1000) / 10 : 0); // percentual com 1 casa
function jogador(uid, r) {
  const partidas = num(r.g), vit = num(r.w), rg = num(r.rg), rw = num(r.rw);
  return {
    id: uid,
    nome: r.n,
    abates: num(r.k),
    vitorias: vit,
    partidas,
    taxa_vitoria: taxa(vit, partidas),
    pontos_ranqueado: num(r.rp),
    partidas_ranqueado: rg,
    vitorias_ranqueado: rw,
    taxa_vitoria_ranqueado: taxa(rw, rg),
    rt: num(r.rt),
  };
}

const ID_OK = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TEXTO = 20000;
const cortar = (s) => (s.length > MAX_TEXTO ? s.slice(0, MAX_TEXTO) + '\n... (cortado, use limite menor ou id)' : s);
const json = (v) => cortar(JSON.stringify(v, null, 2));

// lê uma coleção do banco (somente players, clans, clanstats; nunca inbox/requests/pics)
async function lerDb(env, caminho) {
  const r = await env.ROOM.get(env.ROOM.idFromName('DB#')).fetch('https://r/db/' + caminho);
  if (!r.ok) throw new Error('Banco respondeu http ' + r.status);
  return await r.json();
}

async function listarPlayers(env) {
  const o = (await lerDb(env, 'players')) || {};
  return Object.entries(o)
    .filter(([, v]) => v && typeof v === 'object' && typeof v.n === 'string')
    .map(([uid, v]) => jogador(uid, v));
}

const CRITERIOS = ['pontos_ranqueado', 'abates', 'vitorias', 'partidas', 'taxa_vitoria', 'taxa_vitoria_ranqueado'];

const MCP_TOOLS = [
  {
    name: 'get_ranking',
    description: 'Top jogadores do Fire Strike. Ordena por pontos_ranqueado (padrão), abates, vitorias, partidas, taxa_vitoria ou taxa_vitoria_ranqueado.',
    inputSchema: {
      type: 'object',
      properties: {
        por: { type: 'string', enum: CRITERIOS, description: 'Critério de ordenação' },
        limite: { type: 'number', description: 'Quantos jogadores (1 a 50, padrão 10)' },
        min_partidas: { type: 'number', description: 'Só jogadores com pelo menos X partidas (útil para taxas de vitória)' },
      },
    },
  },
  {
    name: 'find_player',
    description: 'Procura um jogador pelo nome (ignora maiúsculas) e devolve as estatísticas.',
    inputSchema: {
      type: 'object',
      properties: { nome: { type: 'string', description: 'Nome do jogador' } },
      required: ['nome'],
    },
  },
  {
    name: 'get_player',
    description: 'Devolve as estatísticas de um jogador pelo id (uid) e a posição dele no ranking ranqueado.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID (uid) do jogador' } },
      required: ['id'],
    },
  },
  {
    name: 'get_summary',
    description: 'Resumo geral do jogo: total de jogadores, somas de abates/vitórias/partidas e os 3 melhores do ranqueado.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_clans',
    description: 'Lista os clãs cadastrados (dados brutos do banco).',
    inputSchema: {
      type: 'object',
      properties: { limite: { type: 'number', description: 'Quantos clãs (1 a 50, padrão 20)' } },
    },
  },
  {
    name: 'find_clan',
    description: 'Procura clãs cujo registro contenha o texto informado (nome ou tag, ignora maiúsculas).',
    inputSchema: {
      type: 'object',
      properties: { nome: { type: 'string', description: 'Texto a procurar' } },
      required: ['nome'],
    },
  },
  {
    name: 'get_clan',
    description: 'Devolve o registro de um clã pelo id e as estatísticas dele (clanstats), se existirem.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID do clã' } },
      required: ['id'],
    },
  },
  {
    name: 'read_db',
    description: 'Leitura bruta do banco. colecao: players, clans ou clanstats. Com id lê só um registro; sem id lista até 50.',
    inputSchema: {
      type: 'object',
      properties: {
        colecao: { type: 'string', enum: ['players', 'clans', 'clanstats'], description: 'Coleção' },
        id: { type: 'string', description: 'ID do registro (opcional)' },
        limite: { type: 'number', description: 'Quantos registros ao listar (1 a 50, padrão 20)' },
      },
      required: ['colecao'],
    },
  },
  // ---- novas na v4 ----
  {
    name: 'health_check',
    description: 'Diagnóstico: testa se o banco responde, conta registros em players/clans/clanstats e mostra os campos de um jogador de exemplo.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_players',
    description: 'Lista jogadores com paginação, ordenados por um critério (padrão pontos_ranqueado).',
    inputSchema: {
      type: 'object',
      properties: {
        por: { type: 'string', enum: CRITERIOS, description: 'Critério de ordenação' },
        pagina: { type: 'number', description: 'Página (começa em 1)' },
        limite: { type: 'number', description: 'Jogadores por página (1 a 50, padrão 20)' },
        min_partidas: { type: 'number', description: 'Só jogadores com pelo menos X partidas' },
      },
    },
  },
  {
    name: 'compare_players',
    description: 'Compara dois jogadores lado a lado (por nome ou id) e mostra a diferença em cada estatística.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'Nome ou id do primeiro jogador' },
        b: { type: 'string', description: 'Nome ou id do segundo jogador' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'get_averages',
    description: 'Médias do jogo (abates, vitórias, partidas, pontos, taxa geral de vitória) e o recordista em cada critério.',
    inputSchema: {
      type: 'object',
      properties: { min_partidas: { type: 'number', description: 'Mínimo de partidas para entrar nos recordes de taxa (padrão 10)' } },
    },
  },
];

const limitar = (x, pad, max) => Math.max(1, Math.min(max, Math.floor(+x || pad)));
const primeiros = (o, n) => Object.fromEntries(Object.entries(o || {}).slice(0, n));
const media = (arr, f) => (arr.length ? Math.round((arr.reduce((s, p) => s + p[f], 0) / arr.length) * 10) / 10 : 0);

// acha um jogador por id exato, nome exato ou nome parcial (nessa ordem)
function achar(todos, q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const l = s.toLowerCase();
  return todos.find((p) => p.id === s) || todos.find((p) => p.nome.toLowerCase() === l) || todos.find((p) => p.nome.toLowerCase().includes(l)) || null;
}

async function mcpFerramenta(env, name, a) {
  a = a || {};
  if (name === 'get_ranking') {
    const todos = await listarPlayers(env);
    const por = CRITERIOS.includes(a.por) ? a.por : 'pontos_ranqueado';
    const lim = limitar(a.limite, 10, 50);
    const min = Math.max(0, Math.floor(+a.min_partidas || 0));
    const base = min ? todos.filter((p) => p.partidas >= min) : todos;
    const top = base.sort((x, y) => y[por] - x[por]).slice(0, lim);
    return json({ ordenado_por: por, total_jogadores: todos.length, considerados: base.length, top });
  }
  if (name === 'find_player') {
    const todos = await listarPlayers(env);
    const n = String(a.nome || '').toLowerCase().trim();
    if (!n) throw new Error('Informe o nome');
    const achou = todos.filter((p) => p.nome.toLowerCase() === n);
    const parecidos = achou.length ? achou : todos.filter((p) => p.nome.toLowerCase().includes(n)).slice(0, 10);
    return parecidos.length ? json(parecidos) : 'Jogador não encontrado.';
  }
  if (name === 'get_player') {
    const id = String(a.id || '');
    if (!ID_OK.test(id)) throw new Error('ID inválido');
    const todos = await listarPlayers(env);
    const p = todos.find((x) => x.id === id);
    if (!p) return 'Jogador não encontrado.';
    const ordem = todos.slice().sort((x, y) => y.pontos_ranqueado - x.pontos_ranqueado);
    return json({ ...p, posicao_ranqueado: ordem.findIndex((x) => x.id === id) + 1, de: todos.length });
  }
  if (name === 'get_summary') {
    const todos = await listarPlayers(env);
    const soma = (f) => todos.reduce((s, p) => s + p[f], 0);
    const top3 = todos.slice().sort((x, y) => y.pontos_ranqueado - x.pontos_ranqueado).slice(0, 3);
    return json({
      total_jogadores: todos.length,
      total_abates: soma('abates'),
      total_vitorias: soma('vitorias'),
      total_partidas: soma('partidas'),
      total_partidas_ranqueado: soma('partidas_ranqueado'),
      top3_ranqueado: top3,
    });
  }
  if (name === 'list_clans') {
    const o = (await lerDb(env, 'clans')) || {};
    const lim = limitar(a.limite, 20, 50);
    return json({ total_clas: Object.keys(o).length, clas: primeiros(o, lim) });
  }
  if (name === 'find_clan') {
    const n = String(a.nome || '').toLowerCase().trim();
    if (!n) throw new Error('Informe o nome');
    const o = (await lerDb(env, 'clans')) || {};
    const achou = Object.entries(o).filter(([id, v]) => (id + ' ' + JSON.stringify(v)).toLowerCase().includes(n)).slice(0, 10);
    return achou.length ? json(Object.fromEntries(achou)) : 'Clã não encontrado.';
  }
  if (name === 'get_clan') {
    const id = String(a.id || '');
    if (!ID_OK.test(id)) throw new Error('ID inválido');
    const [clan, stats] = await Promise.all([lerDb(env, 'clans/' + id), lerDb(env, 'clanstats/' + id)]);
    if (clan === null && stats === null) return 'Clã não encontrado.';
    return json({ id, clan, clanstats: stats });
  }
  if (name === 'read_db') {
    if (!['players', 'clans', 'clanstats'].includes(a.colecao)) throw new Error('Coleção inválida');
    if (a.id !== undefined && a.id !== '') {
      const id = String(a.id);
      if (!ID_OK.test(id)) throw new Error('ID inválido');
      return json(await lerDb(env, a.colecao + '/' + id));
    }
    const o = (await lerDb(env, a.colecao)) || {};
    return json({ total: Object.keys(o).length, registros: primeiros(o, limitar(a.limite, 20, 50)) });
  }
  // ---- novas na v4 ----
  if (name === 'health_check') {
    const t0 = Date.now();
    const cols = ['players', 'clans', 'clanstats'];
    const res = await Promise.all(cols.map((c) => lerDb(env, c).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, erro: e.message }))));
    const out = { ms: Date.now() - t0 };
    cols.forEach((c, i) => {
      const r = res[i];
      out[c] = r.ok ? { ok: true, total: Object.keys(r.v || {}).length } : { ok: false, erro: r.erro };
    });
    const pl = res[0].ok ? res[0].v || {} : {};
    const validos = Object.values(pl).filter((v) => v && typeof v === 'object' && typeof v.n === 'string');
    out.players.validos = validos.length;
    out.campos_exemplo_player = validos[0] ? Object.keys(validos[0]) : [];
    out.tudo_ok = res.every((r) => r.ok);
    out.aviso = out.players.total === 0 ? 'Banco de players vazio: se era para ter dados, o Worker pode estar apontando para outro Durable Object (DB#) ou os dados não foram migrados.' : undefined;
    return json(out);
  }
  if (name === 'list_players') {
    const todos = await listarPlayers(env);
    const por = CRITERIOS.includes(a.por) ? a.por : 'pontos_ranqueado';
    const lim = limitar(a.limite, 20, 50);
    const min = Math.max(0, Math.floor(+a.min_partidas || 0));
    const base = (min ? todos.filter((p) => p.partidas >= min) : todos).sort((x, y) => y[por] - x[por]);
    const paginas = Math.max(1, Math.ceil(base.length / lim));
    const pagina = Math.min(paginas, Math.max(1, Math.floor(+a.pagina || 1)));
    return json({ ordenado_por: por, total: base.length, pagina, paginas, jogadores: base.slice((pagina - 1) * lim, pagina * lim) });
  }
  if (name === 'compare_players') {
    const todos = await listarPlayers(env);
    const A = achar(todos, a.a), B = achar(todos, a.b);
    if (!A || !B) return 'Não encontrei ' + (!A && !B ? 'nenhum dos dois' : !A ? 'o jogador a' : 'o jogador b') + '.';
    const campos = ['abates', 'vitorias', 'partidas', 'taxa_vitoria', 'pontos_ranqueado', 'partidas_ranqueado', 'vitorias_ranqueado', 'taxa_vitoria_ranqueado'];
    const diferenca = {};
    for (const c of campos) diferenca[c] = Math.round((A[c] - B[c]) * 10) / 10; // positivo = a na frente
    return json({ a: A, b: B, diferenca_a_menos_b: diferenca });
  }
  if (name === 'get_averages') {
    const todos = await listarPlayers(env);
    if (!todos.length) return 'Sem jogadores no banco.';
    const min = Math.max(0, Math.floor(a.min_partidas === undefined ? 10 : +a.min_partidas || 0));
    const rec = (f, base) => { const t = base.slice().sort((x, y) => y[f] - x[f])[0]; return t ? { nome: t.nome, id: t.id, valor: t[f] } : null; };
    const elegiveis = todos.filter((p) => p.partidas >= min);
    const elegiveisRank = todos.filter((p) => p.partidas_ranqueado >= min);
    const totV = todos.reduce((s, p) => s + p.vitorias, 0), totP = todos.reduce((s, p) => s + p.partidas, 0);
    return json({
      total_jogadores: todos.length,
      medias: {
        abates: media(todos, 'abates'),
        vitorias: media(todos, 'vitorias'),
        partidas: media(todos, 'partidas'),
        pontos_ranqueado: media(todos, 'pontos_ranqueado'),
        taxa_vitoria_geral: taxa(totV, totP),
      },
      min_partidas_para_taxas: min,
      recordes: {
        pontos_ranqueado: rec('pontos_ranqueado', todos),
        abates: rec('abates', todos),
        vitorias: rec('vitorias', todos),
        partidas: rec('partidas', todos),
        taxa_vitoria: rec('taxa_vitoria', elegiveis),
        taxa_vitoria_ranqueado: rec('taxa_vitoria_ranqueado', elegiveisRank),
      },
    });
  }
  throw new Error('Ferramenta desconhecida: ' + name);
}

async function mcpTratar(env, msg) {
  const { id, method, params } = msg || {};
  if (id === undefined) return null; // notificação
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize')
    return ok({
      protocolVersion: (params && params.protocolVersion) || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'Fire Strike', version: '1.2.0' },
    });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: MCP_TOOLS });
  if (method === 'tools/call') {
    try {
      const t = await mcpFerramenta(env, params && params.name, params && params.arguments);
      return ok({ content: [{ type: 'text', text: t }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: 'Erro: ' + e.message }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Método não suportado: ' + method } };
}

async function mcp(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS });
  if (req.method !== 'POST') return new Response('Use POST', { status: 405, headers: MCP_CORS });
  let corpo;
  try { corpo = await req.json(); }
  catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, { status: 400, headers: MCP_CORS }); }
  const lote = Array.isArray(corpo);
  const rs = (await Promise.all((lote ? corpo : [corpo]).map((m) => mcpTratar(env, m)))).filter(Boolean);
  if (!rs.length) return new Response(null, { status: 202, headers: MCP_CORS });
  return Response.json(lote ? rs : rs[0], { headers: MCP_CORS });
}

// Salas e lobby novos, pedidos na America do Sul. O banco (DB#) continua igual para nao perder o ranking.
const stub = (env, name) => env.ROOM.get(env.ROOM.idFromName(name), { locationHint: 'sam' });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    if (p === '/mcp') return mcp(req, env);
    // endpoints de OAuth/descoberta precisam dar 404, senão o Claude acha que existe login
    if (p.startsWith('/.well-known/')) return new Response('Not found', { status: 404 });
    if (p === '/where') {
      // diagnostico: abra https://SEU-WORKER/where e veja em qual datacenter estao a borda (perto de voce) e a sala
      const code = (u.searchParams.get('room') || 'sala1').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'sala1';
      let room = '?';
      try { room = (await (await stub(env, 'r2#' + code).fetch(req)).json()).room; } catch {}
      return new Response(JSON.stringify({ borda: (req.cf && req.cf.colo) || '?', sala: room }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    if (p.startsWith('/db')) {
      // responde preflight e caminhos invalidos aqui, sem acordar o Durable Object (economiza a cota do plano gratis)
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Arr-Dev, X-Arr-Acc', 'Access-Control-Max-Age': '86400' };
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const top = p.replace(/^\/db\/?/, '').replace(/\.json$/, '').split('/')[0];
      if (top && !['players', 'clans', 'clanstats', 'requests', 'inbox', 'pics'].includes(top))
        return new Response('null', { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      return env.ROOM.get(env.ROOM.idFromName('DB#')).fetch(req);
    }
    if (p === '/lobby') return stub(env, 'LOBBY2#').fetch(req);
    const m = p.match(/^\/room\/([a-z0-9]{3,8})$/);
    if (!m) return p === '/' ? new Response('Armada Royale relay OK') : new Response('Not found', { status: 404 });
    return stub(env, 'r2#' + m[1]).fetch(req);
  }
};
