// ==========================================
// CONFIGURAÇÕES GLOBAIS
// ==========================================
const STREMIO_API = 'https://api.strem.io/api';
const SELF_ID = 'com.exemplo.stremio.proxy'; // Altere para o ID único do seu addon
const UA = 'StremioAddonProxy/1.0';
const UPSTREAMS = []; // URLs de addons fixos opcionais (ex: ['https://outro-addon.com'])

// ==========================================
// FUNÇÕES DE UTILIDADE E DECODE (BASE64)
// ==========================================
const td = new TextDecoder();

function b64uParaBytes(b64u) {
  let b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function lerConfigConta(b64) {
  if (!b64) return null;
  try {
    const j = JSON.parse(td.decode(b64uParaBytes(b64)));
    if (!j || typeof j !== 'object') return null;
    const a = (Array.isArray(j.a) ? j.a : [])
      .filter((x) => x && typeof x.u === 'string' && /^https?:\/\//i.test(x.u))
      .slice(0, 40)
      .map((x) => ({ 
        n: String(x.n || hostDe(x.u)).slice(0, 60), 
        u: limparUrl(x.u), 
        types: Array.isArray(x.t) ? x.t : [], 
        prefixes: Array.isArray(x.p) ? x.p : [] 
      }));
    const k = typeof j.k === 'string' ? j.k : '';
    return k || a.length ? { k, a } : null;
  } catch { return null; }
}

const limparUrl = (u) => String(u || '').trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');

function hostDe(u) { 
  try { return new URL(u).hostname; } catch { return ''; } 
}

function recursoStream(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { 
      if (r === 'stream') return { types: m.types || [], prefixes: m.idPrefixes || [] }; 
    }
    else if (r && r.name === 'stream') {
      return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
    }
  }
  return null;
}

// ==========================================
// INTEGRAÇÃO COM A API DO STREMIO
// ==========================================
const cacheContas = new Map();

async function addonsDaConta(authKey) {
  const hit = cacheContas.get(authKey);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.lista;
  
  const r = await fetch(`${STREMIO_API}/addonCollectionGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ type: 'AddonCollectionGet', authKey, update: true }),
    signal: AbortSignal.timeout(10000),
  });
  
  if (!r.ok) throw new Error('Stremio HTTP ' + r.status);
  const j = await r.json();
  if (!j.result || !Array.isArray(j.result.addons)) {
    throw new Error('sessão do Stremio inválida ou expirada (gere o link de novo em /configure)');
  }
  
  const lista = [];
  for (const a of j.result.addons) {
    if (!a || !a.manifest || a.manifest.id === SELF_ID || !/^https?:/i.test(a.transportUrl || '')) continue;
    const rec = recursoStream(a.manifest);
    if (!rec) continue; // Apenas addons que possuem o recurso "stream"
    lista.push({ 
      n: a.manifest.name || hostDe(a.transportUrl), 
      u: limparUrl(a.transportUrl), 
      types: rec.types, 
      prefixes: rec.prefixes 
    });
  }
  
  if (cacheContas.size >= 200) cacheContas.clear();
  cacheContas.set(authKey, { t: Date.now(), lista });
  return lista;
}

async function listaDeOrigens(cfgB64, host, tipo, id) {
  let lista = [];
  let erro = null;
  const cfg = lerConfigConta(cfgB64);
  
  if (cfg) {
    lista = lista.concat(cfg.a); 
    if (cfg.k) {
      try { 
        lista = lista.concat(await addonsDaConta(cfg.k)); 
      } catch (e) { 
        erro = e.message; 
        console.error('[conta Stremio]', e.message); 
      }
    }
  }
  
  lista = lista
    .filter((a) => !a.types.length || !tipo || a.types.includes(tipo))
    .filter((a) => !a.prefixes.length || !id || a.prefixes.some((p) => id.startsWith(p)));
    
  for (const u of UPSTREAMS) lista.push({ n: hostDe(u), u, types: [], prefixes: [] });
  
  const vistos = new Set();
  const final = lista
    .filter((a) => hostDe(a.u) !== host) // Nunca chama a si mesmo em loop
    .filter((a) => !vistos.has(a.u) && vistos.add(a.u))
    .slice(0, 30);
    
  return { lista: final, erro, temConta: !!cfg };
}

// ==========================================
// ROTEADOR / MANIPULADOR DO WORKER
// ==========================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    let cfgB64 = '';
    let startIndex = 0;
    
    // Suporte opcional para extrair a config da URL (ex: /:config/manifest.json)
    if (pathParts.length > 0 && pathParts[0] !== 'manifest.json' && pathParts[0] !== 'stream') {
      cfgB64 = pathParts[0];
      startIndex = 1;
    }

    const action = pathParts[startIndex];

    // 1. Rota do Manifesto do Addon
    if (action === 'manifest.json' || pathParts.length === 0) {
      const manifest = {
        id: SELF_ID,
        version: '1.0.0',
        name: 'Stremio Multi-Addon Proxy',
        description: 'Agregador dinâmico de addons do Stremio.',
        types: ['movie', 'series', 'anime'],
        resources: ['stream'],
        idPrefixes: ['tt']
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 2. Rota de Streams
    if (action === 'stream') {
      const tipo = pathParts[startIndex + 1];
      const idComExtensao = pathParts[startIndex + 2] || '';
      const id = idComExtensao.replace(/\.json$/i, '');

      if (!tipo || !id) {
        return new Response(JSON.stringify({ streams: [] }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const { lista, erro } = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
      
      // Realiza as requisições em paralelo para todos os addons filtrados
      const promessas = lista.map(async (origem) => {
        try {
          const res = await fetch(`${origem.u}/stream/${tipo}/${id}.json`, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(8000)
          });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data.streams) ? data.streams : [];
        } catch {
          return [];
        }
      });

      const resultados = await Promise.allSettled(promessas);
      let todosStreams = [];
      for (const r of resultados) {
        if (r.status === 'fulfilled') {
          todosStreams = todosStreams.concat(r.value);
        }
      }

      return new Response(JSON.stringify({ streams: todosStreams, error: erro }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};