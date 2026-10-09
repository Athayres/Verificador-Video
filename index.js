/**
 * Verificador de Duração – addon Stremio para Cloudflare Workers
 *  1. O Stremio pede os streams a este addon (/stream/...).
 *  2. Ele lê SOZINHO a lista de addons da conta do Stremio (login em /configure) e busca os streams só nos
 *     addons que têm "stream". Ficam de fora: este próprio verificador, o Controle de Impróprios (guia dos pais)
 *     e os addons que só têm catálogo/metadados.
 *  3. Cada link direto (http/https) é reescrito para apontar para ESTE Worker (/play/...). Torrents passam sem alteração.
 *     Testes: duração (TMDB), tamanho do arquivo x duração, título gravado no MKV, reconhecimento pelo OpenSubtitles
 *     (OPENSUBTITLES_KEY melhora muito) e nome do arquivo.
 *  4. A lista devolvida ao Stremio traz SÓ os vídeos que passaram no teste: o que o teste reprova (duração diferente
 *     do TMDB, arquivo reconhecido como outro título, nome do arquivo com outro filme/episódio, título não lançado)
 *     é REMOVIDO da lista. O que não deu para medir continua aparecendo e, se for escolhido, é conferido em /play/.
 *  5. TROCA DE ID: este addon responde também pelo META (/meta/...). Ele pega o meta do próximo addon da conta que tenha
 *     meta (abaixo dele na ordem; ex.: Controle de Impróprios, AIOMetadata), troca os ids tt... por vrf:tt... (episódios; nos
 *     filmes também o id e o defaultVideoId) e assim o Stremio só pede os streams a ELE (os outros addons não entendem vrf:).
 *     Ids que não começam com tt (ex.: os que o Controle de Impróprios trocou) não são mexidos.
 *     Instale este addon NO TOPO da lista de addons (o meta vale do primeiro addon que responde).
 *
 * A duração é lida do cabeçalho do arquivo por pedidos Range (MP4/MOV pelo átomo moov/mvhd; MKV/WebM pelo
 * Info/Duration; HLS pela soma dos trechos). O que não dá para medir é conferido pelo NOME do arquivo e, se nada
 * indicar erro, passa.
 *
 * Variáveis (Settings > Variables and Secrets) OU entradas de mesmo nome no KV ligado como "KV":
 *   TMDB_KEY (obrigatória)   SECRET (recomendada; sem ela usa a TMDB_KEY)   PUBLIC_URL (opcional)
 *   INCORRETOS (opcional): ocultar (padrão, remove da lista) | marcar (só renomeia) | bloquear (aparece, mas não toca)
 *   TOLERANCIA (padrão 0.20; séries ×1.5)   TOLERANCIA_MIN (padrão 10)   FFPROBE_TIMEOUT (padrão 8000 ms; vale para a leitura)
 *   ID_FILME (opcional): trocar (padrão: troca o id e o defaultVideoId do filme) | dica (só o defaultVideoId)
 *   CONTROLE (opcional, ligação de serviço): liga este Worker ao Worker do Controle de Impróprios. A Cloudflare não deixa um
 *   Worker chamar outro pelo endereço workers.dev (erro 1042); com a ligação o meta do Controle é lido por dentro.
 */
const SELF_ID = 'community.verificador.duracao';
const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TTL = 24 * 3600 * 1000;

// addons que NUNCA entram como origem de vídeos (além dos que não têm "stream")
const RE_PROPRIO = /verificador de dura[cç][aã]o|^\s*autenticado\s*$/i; // nome antigo e o nome atual do addon
const RE_PARENTAL = /controle de impr[oó]prios?|guia dos pais|parents?[ _-]?guide|parental|classifica[cç][aã]o indicativa|content[ _-]?(advisory|rating|warning)|age[ _-]?(rating|gate|block)/i;

let TMDB_KEY = '';
let PUBLIC_URL = '';
let SECRET = '';
let KV = null;
let TOL = 0.20;
let TOL_MIN = 10;
const MIN_KBPS = 100; // abaixo disso o arquivo é pequeno demais para a duração (trailer/placeholder)
let TIMEOUT = 8000;
let ORCAMENTO_MS = 8000;
let MAX_SONDAS = 12;
let OS_KEY = '';
let MODO = 'ocultar'; // ocultar | marcar | bloquear
let MODO_FILME = 'trocar'; // trocar | dica
let CONTROLE_BIND = null; // ligação de serviço com o Controle de Impróprios (opcional)

async function carregarConfig(env) {
  KV = env.KV || null;
  const ler = async (nome) => {
    let v = String(env[nome] || '').trim();
    if (!v && KV) { try { v = String((await KV.get(nome, { cacheTtl: 300 })) || '').trim(); } catch {} }
    return v;
  };
  TMDB_KEY = await ler('TMDB_KEY');
  PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  SECRET = (await ler('SECRET')) || TMDB_KEY;
  TOL = Number(env.TOLERANCIA || 0.20);
  TOL_MIN = Number(env.TOLERANCIA_MIN || 10);
  TIMEOUT = Number(env.FFPROBE_TIMEOUT || 8000);
  ORCAMENTO_MS = Number(env.VERIFICACAO_MS || 8000);
  MAX_SONDAS = Number(env.MAX_SONDAS || 12);
  OS_KEY = await ler('OPENSUBTITLES_KEY');
  const modo = String((await ler('INCORRETOS')) || '').toLowerCase();
  MODO = ['ocultar', 'marcar', 'bloquear'].includes(modo) ? modo : (String(env.BLOQUEAR_INCORRETOS || '') === '0' ? 'marcar' : 'ocultar');
  MODO_FILME = String((await ler('ID_FILME')) || '').toLowerCase() === 'dica' ? 'dica' : 'trocar';
  CONTROLE_BIND = env.CONTROLE && typeof env.CONTROLE.fetch === 'function' ? env.CONTROLE : null;
}

// ---------- links assinados (impede usar o Worker para abrir endereços quaisquer) ----------
const te = new TextEncoder();
const td = new TextDecoder();
function bytesParaB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uParaBytes(str) {
  let b = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}
let chaveHmac = null;
let chaveDoSegredo = '';
async function getChave() {
  if (!chaveHmac || chaveDoSegredo !== SECRET) {
    chaveHmac = await crypto.subtle.importKey('raw', te.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    chaveDoSegredo = SECRET;
  }
  return chaveHmac;
}
async function criarToken(obj) {
  const p = bytesParaB64u(te.encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await getChave(), te.encode(p)));
  return p + '.' + bytesParaB64u(sig);
}
async function lerToken(tok) {
  const [p, sig] = String(tok || '').split('.');
  if (!p || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await getChave(), b64uParaBytes(sig), te.encode(p));
    return ok ? JSON.parse(td.decode(b64uParaBytes(p))) : null;
  } catch { return null; }
}

// ---------- caches (memória do Worker + KV, se ligado) ----------
const mem = { runtime: new Map(), vered: new Map(), os: new Map() };
async function hashCurto(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  return Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function cLer(tipo, chave) {
  const m = mem[tipo];
  const e = m.get(chave);
  if (e && Date.now() - e.t < TTL) return e.v;
  if (e) m.delete(chave);
  if (KV) {
    try {
      const w = await KV.get(`${tipo}:${await hashCurto(chave)}`, 'json');
      if (w) { m.set(chave, { v: w.v, t: Date.now() }); return w.v; }
    } catch {}
  }
  return undefined;
}
async function cGravar(tipo, chave, v) {
  const m = mem[tipo];
  if (m.size >= 3000) m.clear();
  m.set(chave, { v, t: Date.now() });
  if (KV) {
    try { await KV.put(`${tipo}:${await hashCurto(chave)}`, JSON.stringify({ v }), { expirationTtl: 24 * 3600 }); } catch {}
  }
}

// ---------- TMDB: runtime em minutos ----------
async function tmdb(caminho, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + caminho);
  u.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let erro = null;
  for (let t = 0; t < 3; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, t * 400));
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
      erro = new Error('TMDB ' + r.status);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      erro = e;
      if (e && e.name === 'TimeoutError') break;
    }
  }
  throw erro;
}

function partesDoId(id) {
  const [imdb, t, e] = String(id).split(':');
  return { imdb, temporada: Number(t) > 0 ? Number(t) : null, episodio: Number(e) > 0 ? Number(e) : null };
}

async function infoTMDB(id, tipo) {
  const c = await cLer('runtime', id + '|' + tipo);
  if (c !== undefined) return c && typeof c === 'object' ? c : { min: c, ano: null, titulos: [] };
  const { imdb, temporada, episodio } = partesDoId(id);
  const f = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
  let min = null;
  let ano = null;
  let titulos = [];
  let lancamento = '';
  if (tipo === 'movie') {
    const m = (f.movie_results || [])[0];
    if (m) {
      const det = await tmdb(`/movie/${m.id}`, { language: 'pt-BR' });
      min = det.runtime || null;
      ano = parseInt(String(m.release_date || '').slice(0, 4), 10) || null;
      lancamento = String(m.release_date || '');
      titulos = [m.title, m.original_title, det.title].filter(Boolean);
    }
  } else {
    const sr = (f.tv_results || [])[0];
    if (sr) {
      titulos = [sr.name, sr.original_name].filter(Boolean);
      if (temporada && episodio) {
        try {
          const ep = await tmdb(`/tv/${sr.id}/season/${temporada}/episode/${episodio}`);
          min = ep.runtime || null;
          lancamento = String(ep.air_date || '');
        } catch { /* usa o geral */ }
      }
      if (!min) {
        const d = await tmdb(`/tv/${sr.id}`);
        min = (d.episode_run_time && d.episode_run_time[0]) || (d.last_episode_to_air && d.last_episode_to_air.runtime) || null;
      }
    }
  }
  const info = { min, ano, titulos, lancamento };
  await cGravar('runtime', id + '|' + tipo, info);
  return info;
}
async function runtimeMin(id, tipo) { return (await infoTMDB(id, tipo)).min; }

// ---------- duração do arquivo (substitui o ffprobe): lê só o cabeçalho com pedidos Range ----------
async function lerFaixa(url, ini, tam) {
  const r = await fetch(url, {
    headers: { Range: `bytes=${ini}-${ini + tam - 1}`, 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status !== 206 && r.status !== 200) { try { await r.body.cancel(); } catch {} return null; }
  const semRange = r.status === 200; // o servidor ignorou o Range: o corpo começa no byte 0
  const cr = r.headers.get('content-range');
  const m = cr && cr.match(/\/(\d+)\s*$/);
  const total = m ? Number(m[1]) : (Number(r.headers.get('content-length')) || null);
  if (semRange && ini > 0) { try { await r.body.cancel(); } catch {} return { dados: null, total, semRange }; }
  const leitor = r.body.getReader();
  const partes = [];
  let lidos = 0;
  while (lidos < tam) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
  }
  try { await leitor.cancel(); } catch {}
  const dados = new Uint8Array(Math.min(lidos, tam));
  let p = 0;
  for (const v of partes) {
    const n = Math.min(v.length, dados.length - p);
    if (n <= 0) break;
    dados.set(v.subarray(0, n), p);
    p += n;
  }
  return { dados, total, semRange };
}

function mvhdSegundos(c) {
  for (let i = 4; i + 4 <= c.length; i++) {
    if (c[i] === 0x6d && c[i + 1] === 0x76 && c[i + 2] === 0x68 && c[i + 3] === 0x64) { // 'mvhd'
      const b = i + 4;
      const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
      let escala;
      let dur;
      if (c[b] === 1) {
        if (b + 32 > c.length) return null;
        escala = dv.getUint32(b + 20);
        dur = Number(dv.getBigUint