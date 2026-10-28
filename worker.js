// ============================================================
// Servidor MCP para o relay "Armada Royale" (somente leitura)
// COMO USAR: no seu Worker, APAGUE o bloco final "export default { ... }"
// e cole TUDO deste arquivo no lugar (o resto do arquivo fica igual).
// URL no Claude: https://armada-relay.rdz777zd.workers.dev/mcp
// ============================================================

const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
};

// campos do registro /players/<uid> (k, w, g, rp, rg, rw, rt) com nomes legíveis
const num = (x) => (typeof x === 'number' ? x : 0);
function jogador(uid, r) {
  return {
    id: uid,
    nome: r.n,
    abates: num(r.k),
    vitorias: num(r.w),
    partidas: num(r.g),
    pontos_ranqueado: num(r.rp),
    partidas_ranqueado: num(r.rg),
    vitorias_ranqueado: num(r.rw),
    rt: num(r.rt),
  };
}

async function listarPlayers(env) {
  const r = await env.ROOM.get(env.ROOM.idFromName('DB#')).fetch('https://r/db/players');
  if (!r.ok) throw new Error('Banco respondeu http ' + r.status);
  const o = (await r.json()) || {};
  return Object.entries(o)
    .filter(([, v]) => v && typeof v === 'object' && typeof v.n === 'string')
    .map(([uid, v]) => jogador(uid, v));
}

const MCP_TOOLS = [
  {
    name: 'get_ranking',
    description: 'Top jogadores do Fire Strike. Ordena por pontos_ranqueado (padrão), abates ou vitorias.',
    inputSchema: {
      type: 'object',
      properties: {
        por: { type: 'string', enum: ['pontos_ranqueado', 'abates', 'vitorias'], description: 'Critério de ordenação' },
        limite: { type: 'number', description: 'Quantos jogadores (1 a 50, padrão 10)' },
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
];

async function mcpFerramenta(env, name, a) {
  a = a || {};
  const todos = await listarPlayers(env);
  if (name === 'get_ranking') {
    const por = ['abates', 'vitorias', 'pontos_ranqueado'].includes(a.por) ? a.por : 'pontos_ranqueado';
    const lim = Math.max(1, Math.min(50, Math.floor(+a.limite || 10)));
    const top = todos.sort((x, y) => y[por] - x[por]).slice(0, lim);
    return JSON.stringify({ ordenado_por: por, total_jogadores: todos.length, top }, null, 2);
  }
  if (name === 'find_player') {
    const n = String(a.nome || '').toLowerCase().trim();
    if (!n) throw new Error('Informe o nome');
    const achou = todos.filter((p) => p.nome.toLowerCase() === n);
    const parecidos = achou.length ? achou : todos.filter((p) => p.nome.toLowerCase().includes(n)).slice(0, 10);
    return parecidos.length ? JSON.stringify(parecidos, null, 2) : 'Jogador não encontrado.';
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
      serverInfo: { name: 'Fire Strike', version: '1.0.0' },
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

// Salas, chat e lobby ficam na America do Sul. O banco (DB#) continua no mesmo objeto para nao perder o ranking.
const stub = (env, name) => env.ROOM.get(env.ROOM.idFromName(name), { locationHint: 'sam' });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    if (p === '/mcp') return mcp(req, env);
    // CORREÇÃO: endpoints de OAuth/descoberta devem dar 404 (senão o Claude acha que há OAuth)
    if (p.startsWith('/.well-known/')) return new Response('Not found', { status: 404 });
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
    // CORREÇÃO: só a raiz responde 200; o resto dá 404
    if (!m) return p === '/' ? new Response('Armada Royale relay OK') : new Response('Not found', { status: 404 });
    return stub(env, 'r2#' + m[1]).fetch(req);
  }
};
