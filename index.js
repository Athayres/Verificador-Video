/**
 * Verificador de Duração – addon Stremio para Cloudflare Workers
 * Adaptado do verificador.js (Node/Render). Mesma lógica:
 *  1. O Stremio pede os streams a este addon (/stream/...).
 *  2. Ele busca a lista nos addons de origem (UPSTREAM_URL) e reescreve cada link direto (http/https)
 *     para apontar para ESTE Worker (/play/...). Torrents e outros tipos passam sem alteração.
 *  3. Quando você ESCOLHE um link, o Stremio chama /play/...: o Worker lê a duração do vídeo e compara
 *     com o runtime do TMDB (pelo tt).
 *       - bate (ou não deu para ler) -> redireciona para o link original e o vídeo toca
 *       - não bate                   -> responde erro e o vídeo NÃO abre
 *
 * DIFERENÇA para o Render: o Worker não executa programas (não existe ffprobe). A duração é lida do
 * cabeçalho do arquivo por pedidos Range (MP4/MOV pelo átomo moov/mvhd; MKV/WebM pelo Info/Duration).
 * HLS (.m3u8) também é medido (soma dos trechos). O que não dá para medir (torrent, TS, AVI, servidor sem Range...)
 * é conferido só pelo NOME do arquivo (ano do filme e temporada/episódio) e, se nada indicar erro, toca normalmente.
 *
 * Os addons de origem NÃO são digitados: na página /configure você entra com a sua conta do Stremio, e o Worker
 * lê a lista de addons instalados na conta e usa só os que têm "stream" (ignora o próprio Verificador).
 *
 * Variáveis (Settings > Variables and Secrets) OU entradas de mesmo nome no KV ligado como "KV":
 *   TMDB_KEY (obrigatória)   SECRET (recomendada; sem ela usa a TMDB_KEY)
 *   UPSTREAM_URL (opcional: links extras, separados por espaço ou vírgula)   PUBLIC_URL (opcional)
 *   TOLERANCIA (padrão 0.10)   TOLERANCIA_MIN (padrão 5)   FFPROBE_TIMEOUT (padrão 8000 ms; vale para a leitura)
 */
const SELF_ID = 'community.verificador.duracao';
const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TTL = 24 * 3600 * 1000;

let TMDB_KEY = '';
let UPSTREAMS = [];
let PUBLIC_URL = '';
let SECRET = '';
let KV = null;
let TOL = 0.10;
let TOL_MIN = 5;
let TIMEOUT = 8000;
let ORCAMENTO_MS = 8000;
let MAX_SONDAS = 12;
let OS_KEY = '';
let BLOQUEAR = true;

async function carregarConfig(env) {
  KV = env.KV || null;
  const ler = async (nome) => {
    let v = String(env[nome] || '').trim();
    if (!v && KV) { try { v = String((await KV.get(nome, { cacheTtl: 300 })) || '').trim(); } catch {} }
    return v;
  };
  TMDB_KEY = await ler('TMDB_KEY');
  UPSTREAMS = (await ler('UPSTREAM_URL')).split(/[\s,]+/).filter(Boolean)
    .map((u) => u.replace(/\/manifest\.json$/, '').replace(/\/+$/, ''));
  PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  SECRET = (await ler('SECRET')) || TMDB_KEY;
  TOL = Number(env.TOLERANCIA || 0.10);
  TOL_MIN = Number(env.TOLERANCIA_MIN || 5);
  TIMEOUT = Number(env.FFPROBE_TIMEOUT || 8000);
  ORCAMENTO_MS = Number(env.VERIFICACAO_MS || 8000);
  MAX_SONDAS = Number(env.MAX_SONDAS || 12);
  OS_KEY = await ler('OPENSUBTITLES_KEY');
  BLOQUEAR = String(env.BLOQUEAR_INCORRETOS || '1') !== '0';
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
      min = (await tmdb(`/movie/${m.id}`)).runtime || null;
      ano = parseInt(String(m.release_date || '').slice(0, 4), 10) || null;
      lancamento = String(m.release_date || '');
      titulos = [m.title, m.original_title].filter(Boolean);
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
        dur = Number(dv.getBigUint64(b + 24));
      } else {
        if (b + 20 > c.length) return null;
        escala = dv.getUint32(b + 12);
        dur = dv.getUint32(b + 16);
      }
      if (!escala || !dur || dur >= 0xFFFFFFFF) return null; // fragmentado/desconhecido
      return dur / escala;
    }
  }
  return null;
}

async function duracaoMP4(url, ini) {
  const d0 = ini.dados;
  const total = ini.total;
  const ler = async (off, tam) => {
    if (off < d0.length && (off + tam <= d0.length || (total != null && d0.length >= total))) return d0.subarray(off, Math.min(off + tam, d0.length));
    if (ini.semRange) return null; // sem Range não dá para pular até o moov
    const r = await lerFaixa(url, off, tam);
    return r && r.dados;
  };
  let off = 0;
  for (let n = 0; n < 12; n++) {
    const cab = await ler(off, 16);
    if (!cab || cab.length < 8) return null;
    const dv = new DataView(cab.buffer, cab.byteOffset, cab.byteLength);
    let tam = dv.getUint32(0);
    const tipo = String.fromCharCode(cab[4], cab[5], cab[6], cab[7]);
    if (tam === 1) {
      if (cab.length < 16) return null;
      tam = Number(dv.getBigUint64(8));
    } else if (tam === 0) {
      tam = total ? total - off : 0;
    }
    if (tipo === 'moov') {
      const corpo = await ler(off, Math.min(tam, 8192));
      return corpo ? mvhdSegundos(corpo) : null;
    }
    if (!(tam >= 8)) return null;
    off += tam;
    if (total && off >= total) return null;
  }
  return null;
}

function lerVint(d, p, ehId) {
  const b = d[p];
  if (b === undefined || b === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(b & mask)) { len++; mask >>= 1; }
  if (p + len > d.length) return null;
  let v = ehId ? b : (b & (mask - 1));
  let tudoUm = (b & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) { v = v * 256 + d[p + i]; if (d[p + i] !== 0xFF) tudoUm = false; }
  return { v, len, desconhecido: !ehId && tudoUm };
}
function lerUint(bytes) { let v = 0; for (const b of bytes) v = v * 256 + b; return v; }

function infoMKV(d, ini, fim) {
  let escala = 1000000;
  let dur = null;
  let p = ini;
  while (p < fim) {
    const id = lerVint(d, p, true);
    if (!id) break;
    p += id.len;
    const sz = lerVint(d, p, false);
    if (!sz) break;
    p += sz.len;
    const corpo = d.subarray(p, Math.min(p + sz.v, d.length));
    if (id.v === 0x2AD7B1) escala = lerUint(corpo);
    else if (id.v === 0x4489 && (corpo.length === 4 || corpo.length === 8)) {
      const dv = new DataView(corpo.buffer, corpo.byteOffset, corpo.byteLength);
      dur = corpo.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
    }
    p += sz.v;
  }
  return dur != null && Number.isFinite(dur) ? (dur * escala) / 1e9 : null;
}

function duracaoMKV(d) {
  let p = 0;
  while (p < d.length) {
    const id = lerVint(d, p, true);
    if (!id) return null;
    p += id.len;
    const sz = lerVint(d, p, false);
    if (!sz) return null;
    p += sz.len;
    if (id.v === 0x18538067) continue;                 // Segment: entra nos filhos
    if (id.v === 0x1549A966) return infoMKV(d, p, Math.min(p + sz.v, d.length)); // Info
    if (id.v === 0x1F43B675) return null;              // Cluster antes do Info
    if (sz.desconhecido) return null;
    p += sz.v;
  }
  return null;
}

async function lerTexto(url, max) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) { try { await r.body.cancel(); } catch {} return null; }
  const leitor = r.body.getReader();
  const partes = [];
  let lidos = 0;
  while (lidos < max) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
  }
  try { await leitor.cancel(); } catch {}
  const tudo = new Uint8Array(lidos);
  let p = 0;
  for (const v of partes) { tudo.set(v, p); p += v.length; }
  return td.decode(tudo);
}

// HLS: soma a duração dos trechos (só playlist completa, com #EXT-X-ENDLIST); se for a lista mestre, usa a 1ª variante
async function duracaoHLS(url) {
  let texto = await lerTexto(url, 800000);
  for (let n = 0; n < 2 && texto && texto.includes('#EXT-X-STREAM-INF'); n++) {
    const linhas = texto.split(/\r?\n/);
    const k = linhas.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const uri = (linhas[k + 1] || '').trim();
    if (!uri || uri.startsWith('#')) return null;
    url = new URL(uri, url).href;
    texto = await lerTexto(url, 800000);
  }
  if (!texto || !texto.includes('#EXT-X-ENDLIST')) return null;
  let total = 0;
  for (const m of texto.matchAll(/#EXTINF:([\d.]+)/g)) total += parseFloat(m[1]);
  return total > 0 ? total : null;
}

// ---------- autenticidade por site externo: o OpenSubtitles identifica o arquivo pelo "hash" ----------
// hash = tamanho + soma (64 bits) dos primeiros e dos últimos 64 KB do arquivo
function hashOpenSubtitles(inicio, fim, tamanho) {
  let h = BigInt(tamanho);
  const soma = (d) => {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    for (let i = 0; i + 8 <= d.length; i += 8) h = (h + dv.getBigUint64(i, true)) & 0xFFFFFFFFFFFFFFFFn;
  };
  soma(inicio);
  soma(fim);
  return h.toString(16).padStart(16, '0');
}

async function hashDoArquivo(url) {
  const ini = await lerFaixa(url, 0, 65536);
  if (!ini || !ini.dados || ini.semRange || !ini.total || ini.total < 131072 || ini.dados.length < 65536) return null;
  const fim = await lerFaixa(url, ini.total - 65536, 65536);
  if (!fim || !fim.dados || fim.dados.length < 65536) return null;
  return { hash: hashOpenSubtitles(ini.dados, fim.dados, ini.total), tamanho: ini.total };
}

const ttDe = (n) => (n && Number(n) ? 'tt' + String(n).padStart(7, '0') : null);

// lista de títulos que o OpenSubtitles conhece para esse hash ([] = hash desconhecido; undefined = consulta falhou)
async function consultarOpenSubtitles(hash, tamanho) {
  const c = await cLer('os', hash);
  if (c !== undefined) return c;
  let achados;
  try {
    if (OS_KEY) {
      const r = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?moviehash=${hash}`, {
        headers: { 'Api-Key': OS_KEY, 'User-Agent': 'VerificadorDuracao v1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return undefined;
      const j = await r.json();
      achados = (j.data || []).filter((x) => x.attributes && x.attributes.moviehash_match).map((x) => {
        const f = x.attributes.feature_details || {};
        return { imdb: ttDe(f.imdb_id), serie: ttDe(f.parent_imdb_id), titulo: f.movie_name || f.title || '' };
      });
    } else { // sem chave: endereço antigo do OpenSubtitles (pode ser desligado a qualquer momento)
      const r = await fetch(`https://rest.opensubtitles.org/search/moviebytesize-${tamanho}/moviehash-${hash}`, {
        headers: { 'X-User-Agent': 'TemporaryUserAgent', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return undefined;
      const j = await r.json();
      achados = (Array.isArray(j) ? j : []).filter((x) => x.MatchedBy === 'moviehash').map((x) => ({
        imdb: ttDe(x.IDMovieImdb), serie: ttDe(x.SeriesIMDBParent), titulo: x.MovieName || '',
      }));
    }
  } catch { return undefined; }
  await cGravar('os', hash, achados);
  return achados;
}

// compara o que o OpenSubtitles sabe sobre o hash com o título pedido
async function autenticidadePorHash(hash, tamanho, id) {
  const achados = await consultarOpenSubtitles(hash, tamanho);
  const POR = 'autenticidade, OpenSubtitles';
  if (!achados || !achados.length) return { status: 'nao_verificado' };
  const pedido = String(id).split(':')[0];
  if (achados.some((a) => a.imdb === pedido || a.serie === pedido)) return { status: 'ok', por: POR, texto: 'o arquivo é reconhecido como este título' };
  const a = achados.find((x) => x.imdb || x.serie);
  if (!a) return { status: 'nao_verificado' };
  return { status: 'errado', por: POR, texto: `este arquivo é conhecido como ${a.titulo ? `"${a.titulo}" ` : ''}(${a.serie || a.imdb}), não ${pedido}` };
}

async function autenticidadeDoLink(url, id) {
  try {
    const h = await hashDoArquivo(url);
    return h ? await autenticidadePorHash(h.hash, h.tamanho, id) : { status: 'nao_verificado' };
  } catch { return { status: 'nao_verificado' }; }
}

// minutos, ou null se não deu para ler
async function duracaoArquivo(url) {
  try {
    const ini = await lerFaixa(url, 0, 65536);
    if (!ini || !ini.dados || ini.dados.length < 12) return null;
    const d = ini.dados;
    let seg = null;
    if (d[0] === 0x23 && d[1] === 0x45 && d[2] === 0x58 && d[3] === 0x54 && d[4] === 0x4D && d[5] === 0x33 && d[6] === 0x55) { // '#EXTM3U' = HLS
      seg = await duracaoHLS(url);
    } else if (d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70) { // 'ftyp' = MP4/MOV
      seg = await duracaoMP4(url, ini);
    } else if (d[0] === 0x1A && d[1] === 0x45 && d[2] === 0xDF && d[3] === 0xA3) { // EBML = MKV/WebM
      seg = duracaoMKV(d);
      if (seg == null && d.length >= 65536) {
        const mais = await lerFaixa(url, 0, 524288);
        if (mais && mais.dados) seg = duracaoMKV(mais.dados);
      }
    }
    return Number.isFinite(seg) && seg > 0 ? seg / 60 : null;
  } catch { return null; }
}

// 'ok' | 'errado' | 'nao_verificado'  (só "errado" impede o vídeo de abrir)
async function veredito({ u, i, t }, rtConhecido) {
  const chave = `${i}|${t}|${u}`;
  const c = await cLer('vered', chave);
  if (c) return c;
  if (!TMDB_KEY) return { status: 'nao_verificado' };
  let r;
  try {
    const [rt, dur] = await Promise.all([rtConhecido !== undefined ? rtConhecido : runtimeMin(i, t), duracaoArquivo(u)]);
    if (rt && dur) {
      const folga = Math.max(rt * TOL, TOL_MIN);
      r = { status: Math.abs(dur - rt) <= folga ? 'ok' : 'errado', tmdbMin: rt, arquivoMin: Math.round(dur) };
    } else {
      const ext = dur ? null : await autenticidadeDoLink(u, i); // duração ilegível: pergunta ao site externo
      if (ext && ext.status !== 'nao_verificado') r = ext;
      else return { status: 'nao_verificado', tmdbMin: rt, arquivoMin: dur && Math.round(dur) };
    }
  } catch {
    return { status: 'nao_verificado' };
  }
  await cGravar('vered', chave, r); // falha passageira não fica guardada
  return r;
}

// ---------- lista de addons da conta do Stremio ----------
function lerConfigConta(b64) {
  if (!b64) return null;
  try {
    const j = JSON.parse(td.decode(b64uParaBytes(b64)));
    if (!j || typeof j !== 'object') return null;
    const a = (Array.isArray(j.a) ? j.a : [])
      .filter((x) => x && typeof x.u === 'string' && /^https?:\/\//i.test(x.u))
      .slice(0, 40)
      .map((x) => ({ n: String(x.n || hostDe(x.u)).slice(0, 60), u: limparUrl(x.u), types: Array.isArray(x.t) ? x.t : [], prefixes: Array.isArray(x.p) ? x.p : [] }));
    const k = typeof j.k === 'string' ? j.k : '';
    return k || a.length ? { k, a } : null;
  } catch { return null; }
}
const limparUrl = (u) => String(u || '').trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
function hostDe(u) { try { return new URL(u).hostname; } catch { return ''; } }

// devolve { types, prefixes } se o manifest tem o recurso "stream" (como texto ou como objeto), senão null
function recursoStream(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { if (r === 'stream') return { types: m.types || [], prefixes: m.idPrefixes || [] }; }
    else if (r && r.name === 'stream') return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
  }
  return null;
}

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
  if (!j.result || !Array.isArray(j.result.addons)) throw new Error('sessão do Stremio inválida ou expirada (gere o link de novo em /configure)');
  const lista = [];
  for (const a of j.result.addons) {
    if (!a || !a.manifest || a.manifest.id === SELF_ID || !/^https?:/i.test(a.transportUrl || '')) continue;
    const rec = recursoStream(a.manifest);
    if (!rec) continue; // só quem tem stream
    lista.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rec.types, prefixes: rec.prefixes });
  }
  if (cacheContas.size >= 200) cacheContas.clear();
  cacheContas.set(authKey, { t: Date.now(), lista });
  return lista;
}

// addons de origem para este pedido: os da conta (filtrados por tipo e prefixo do id) + UPSTREAM_URL, se houver
async function listaDeOrigens(cfgB64, host, tipo, id) {
  let lista = [];
  let erro = null;
  const cfg = lerConfigConta(cfgB64);
  if (cfg) {
    lista = lista.concat(cfg.a); // lista gravada no próprio link (vale mesmo que o addon original seja desinstalado do Stremio)
    if (cfg.k) {
      try { lista = lista.concat(await addonsDaConta(cfg.k)); } catch (e) { erro = e.message; console.error('[conta Stremio]', e.message); }
    }
  }
  lista = lista
    .filter((a) => !a.types.length || !tipo || a.types.includes(tipo))
    .filter((a) => !a.prefixes.length || !id || a.prefixes.some((p) => id.startsWith(p)));
  for (const u of UPSTREAMS) lista.push({ n: hostDe(u), u, types: [], prefixes: [] });
  const vistos = new Set();
  const final = lista
    .filter((a) => hostDe(a.u) !== host)          // nunca chama a si mesmo
    .filter((a) => !vistos.has(a.u) && vistos.add(a.u))
    .slice(0, 30);
  return { lista: final, erro, temConta: !!cfg };
}

// ---------- conferência da lista (marca o título dos vídeos incorretos) ----------
const ehDireto = (s) => !!s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && !(s.behaviorHints && s.behaviorHints.proxyHeaders);

// Confere os links diretos: primeiro o que já está em cache (grátis), depois mede alguns (até MAX_SONDAS, 4 por vez)
// dentro de um tempo limite. O que não terminar a tempo continua sendo conferido em segundo plano e fica no cache.
async function verificarLista(itens, id, tipo, rt, ctx, orcamento) {
  const resultados = new Map();
  const diretos = itens.filter((it) => ehDireto(it.s));
  const emCache = await Promise.all(diretos.map((it) => cLer('vered', `${id}|${tipo}|${it.s.url}`)));
  const pendentes = [];
  diretos.forEach((it, k) => { if (emCache[k]) resultados.set(it, emCache[k]); else pendentes.push(it); });
  const alvo = pendentes.slice(0, MAX_SONDAS);
  let prox = 0;
  const trabalhador = async () => {
    while (prox < alvo.length) {
      const it = alvo[prox++];
      try { resultados.set(it, await veredito({ u: it.s.url, i: id, t: tipo }, rt)); } catch { /* segue */ }
    }
  };
  const todos = Promise.all([0, 1, 2, 3].map(() => trabalhador()));
  await Promise.race([todos, new Promise((ok) => setTimeout(ok, orcamento))]);
  if (ctx && ctx.waitUntil) ctx.waitUntil(todos.catch(() => {}));
  return { resultados, semTempo: Math.max(0, pendentes.length - MAX_SONDAS) };
}

// ---------- conferência pelo NOME do arquivo (para o que não dá para medir) ----------
const MARCA_RELEASE = /\b(bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|hdrip|x264|x265|h264|h265|hevc|remux)\b/i;

function nomeDoArquivo(s) {
  const bh = s.behaviorHints || {};
  if (bh.filename) return String(bh.filename);
  if (typeof s.url === 'string') {
    try {
      const f = decodeURIComponent(new URL(s.url).pathname.split('/').pop() || '');
      if (/\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i.test(f)) return f;
    } catch {}
  }
  const t = String(s.title || s.description || '').split('\n')[0];
  return MARCA_RELEASE.test(t) ? t : '';
}

const p2 = (n) => String(n).padStart(2, '0');
const normalizar = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// devolve o motivo (texto) se o NOME mostra claramente outro filme/episódio; senão null
function checarNome(s, tipo, id, info) {
  const nome = nomeDoArquivo(s);
  if (!nome) return null;
  if (tipo === 'series') {
    const { temporada, episodio } = partesDoId(id);
    if (!temporada || !episodio) return null;
    const m = nome.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?(?:E|-E?)(\d{1,3}))?/i) || nome.match(/\b(\d{1,2})x(\d{2,3})\b/i);
    if (!m) return null;
    const s1 = Number(m[1]);
    const e1 = Number(m[2]);
    const e2 = m[3] ? Number(m[3]) : e1;
    if (s1 !== temporada || episodio < e1 || episodio > e2) return `o arquivo parece ser S${p2(s1)}E${p2(e1)} e você abriu S${p2(temporada)}E${p2(episodio)}`;
    return null;
  }
  if (!info || !info.ano) return null;
  const titulosNum = normalizar((info.titulos || []).join(' '));
  const anos = [];
  for (const m of nome.matchAll(/(?<![\dx])(19|20)\d{2}(?![\dxp])/gi)) {
    if (!titulosNum.includes(m[0])) anos.push(Number(m[0])); // ignora ano que faz parte do título (1917, 2012...)
  }
  if (anos.length && !anos.some((a) => Math.abs(a - info.ano) <= 1)) return `o arquivo parece ser de ${anos[0]} e o filme é de ${info.ano}`;
  return null;
}

// ---------- addons de origem ----------
async function streamsDe(base, tipo, id) {
  try {
    const r = await fetch(`${base}/stream/${tipo}/${encodeURIComponent(id)}.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.streams) ? j.streams : [];
  } catch (e) {
    console.error('origem falhou:', base, e && e.message);
    return [];
  }
}

// Só reescreve link direto sem cabeçalhos especiais (com cabeçalhos, o redirecionamento perderia eles).
async function reescrever(s, base, tipo, id) {
  const bh = s && s.behaviorHints;
  if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return s;
  if (bh && bh.proxyHeaders) return s;
  return Object.assign({}, s, { url: `${base}/play/${await criarToken({ u: s.url, i: id, t: tipo })}` });
}

function manifest(base) {
  return {
    id: 'community.verificador.duracao',
    version: '1.7.0',
    name: 'Verificador de Duração',
    description: 'Repassa os streams de outro addon e remove os vídeos cuja duração não bate com a do filme/episódio no TMDB.',
    logo: `${base}/check_tempo.png`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
function texto(status, msg) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}

function paginaConfig() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verificador de Duração</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#111;color:#fff;padding:20px}
.box{max-width:480px;margin:auto;background:#222;padding:20px;border-radius:10px}
input[type=text],input[type=email],input[type=password]{width:100%;padding:10px;margin:6px 0;background:#333;border:1px solid #444;color:#fff;border-radius:6px;box-sizing:border-box;font:inherit}
button{background:#e50914;color:#fff;border:0;padding:12px;width:100%;border-radius:6px;font-weight:700;font-size:15px;cursor:pointer;margin-top:8px}
button.sec{background:#444}
p{color:#aaa;font-size:13px;line-height:1.4}
label{display:block;padding:6px 0;font-size:14px}
#msg{color:#ffb74d;font-size:14px;min-height:18px}
</style></head><body><div class="box">
<img src="/check_tempo.png" alt="" style="width:72px;height:72px;display:block;margin:0 auto 8px">
<h2 style="text-align:center;margin:6px 0 12px">Verificador de Duração</h2>
<div id="passo1">
<p>Entre com a sua conta do Stremio para escolher quais addons o verificador deve conferir. O e-mail e a senha vão direto para o Stremio, não passam por este servidor.</p>
<input type="email" id="email" placeholder="E-mail do Stremio" autocomplete="username">
<input type="password" id="senha" placeholder="Senha" autocomplete="current-password">
<button onclick="entrar()">Entrar e listar meus addons</button>
</div>
<div id="msg"></div>
<div id="passo2" style="display:none">
<p>Addons com <b>stream</b> encontrados na sua conta. Marque os que o verificador deve conferir:</p>
<div id="lista"></div>
<label><input type="checkbox" id="viva"> Também ler a minha conta a cada uso (pega addons novos sozinho, mas o link passa a conter o acesso à conta)</label>
<button onclick="gerar()">Gerar link</button>
</div>
<div id="resultado" style="display:none">
<p>Instale o link abaixo. <b>Depois você pode desinstalar os addons marcados no Stremio</b>: o verificador guarda os endereços deles no próprio link, e assim os vídeos deles não aparecem duplicados.</p>
<input type="text" id="link" readonly onclick="this.select()">
<button onclick="copiar()">Copiar link</button>
<button class="sec" onclick="instalar()">Instalar no Stremio (app)</button>
<button class="sec" onclick="instalarWeb()">Instalar no Stremio Web</button>
</div></div>
<script>
var caminho='', AUTH='', LISTA=[];
function msg(t){document.getElementById('msg').textContent=t}
function b64u(s){return btoa(unescape(encodeURIComponent(s))).split('+').join('-').split('/').join('_').split('=').join('')}
function copiar(){var c=document.getElementById('link');c.select();document.execCommand('copy');msg('Link copiado!')}
function instalar(){window.location.href='stremio://'+caminho}
function instalarWeb(){window.open('https://web.stremio.com/#/addons?addon='+encodeURIComponent(location.protocol+'//'+caminho),'_blank')}
function temStream(m){
  var rs=m.resources||[];
  for(var i=0;i<rs.length;i++){
    var r=rs[i];
    if(r==='stream')return{t:m.types||[],p:m.idPrefixes||[]};
    if(r&&r.name==='stream')return{t:r.types||m.types||[],p:r.idPrefixes||m.idPrefixes||[]};
  }
  return null;
}
function limpar(u){
  u=String(u||'').trim();
  var i=u.indexOf('/manifest.json');
  if(i>=0)u=u.slice(0,i);
  while(u.length&&u.charAt(u.length-1)==='/')u=u.slice(0,-1);
  return u;
}
async function api(rota,corpo){
  var r=await fetch('https://api.strem.io/api/'+rota,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)});
  return r.json();
}
async function entrar(){
  msg('Entrando...');
  try{
    var j=await api('login',{type:'Login',email:document.getElementById('email').value.trim(),password:document.getElementById('senha').value,facebook:false});
    if(!j.result||!j.result.authKey){msg('Login falhou: confira e-mail e senha.');return}
    AUTH=j.result.authKey;
    var c=await api('addonCollectionGet',{type:'AddonCollectionGet',authKey:AUTH,update:true});
    if(!c.result||!c.result.addons){msg('Não consegui ler a lista de addons da conta.');return}
    LISTA=[];
    c.result.addons.forEach(function(a){
      var m=a.manifest||{};
      if(m.id==='community.verificador.duracao'||!/^https?:/i.test(a.transportUrl||''))return;
      var rec=temStream(m);
      if(!rec)return;
      LISTA.push({n:m.name||a.transportUrl,u:limpar(a.transportUrl),t:rec.t,p:rec.p});
    });
    var div=document.getElementById('lista');
    div.textContent='';
    LISTA.forEach(function(x,i){
      var l=document.createElement('label');
      var cb=document.createElement('input');cb.type='checkbox';cb.checked=true;cb.id='ad'+i;
      l.appendChild(cb);
      l.appendChild(document.createTextNode(' '+x.n));
      div.appendChild(l);
    });
    document.getElementById('passo1').style.display='none';
    document.getElementById('passo2').style.display='block';
    msg(LISTA.length?'Encontrei '+LISTA.length+' addon(s) com stream.':'Nenhum addon com stream encontrado na conta.');
  }catch(e){msg('Erro: '+e.message)}
}
function gerar(){
  var sel=[];
  LISTA.forEach(function(x,i){if(document.getElementById('ad'+i).checked)sel.push({n:x.n,u:x.u,t:x.t,p:x.p})});
  var cfg={a:sel};
  if(document.getElementById('viva').checked)cfg.k=AUTH;
  if(!sel.length&&!cfg.k){msg('Marque pelo menos um addon.');return}
  caminho=location.host+'/'+b64u(JSON.stringify(cfg))+'/manifest.json';
  document.getElementById('link').value=location.protocol+'//'+caminho;
  document.getElementById('resultado').style.display='block';
  msg('Pronto. Copie o link ou instale direto.');
}
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
      }
      await carregarConfig(env);
      const url = new URL(request.url);
      const partes = url.pathname.split('/').filter(Boolean);
      const base = PUBLIC_URL || url.origin;
      if (!partes.length) return Response.redirect(`${url.origin}/configure`, 302);
      const RESERVADOS = ['configure', 'manifest.json', 'stream', 'play', 'health', 'diagnostico', 'check_tempo.png'];
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift(); // /<config>/manifest.json, /<config>/stream/...
      if (partes[0] === 'health') return json({ ok: true });
      if (partes[0] === 'configure') return paginaConfig();
      if (partes[0] === 'manifest.json') return json(manifest(base));

      if (partes[0] === 'check_tempo.png') {
        return new Response(b64uParaBytes(LOGO_B64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (partes[0] === 'diagnostico') { // mostra se as configurações foram lidas (nunca mostra as chaves)
        let tmdbTeste = 'TMDB_KEY não definida';
        if (TMDB_KEY) {
          try { await tmdb('/configuration'); tmdbTeste = 'ok'; } catch (e) { tmdbTeste = 'falhou: ' + String((e && e.message) || e); }
        }
        const o = await listaDeOrigens(cfgB64, url.hostname, null, null);
        return json({
          tmdb_key_definida: !!TMDB_KEY, tmdb_teste: tmdbTeste, secret_definido: !!SECRET, kv_ligado: !!KV,
          opensubtitles: OS_KEY ? 'com chave' : 'sem chave (endereço antigo)',
          bloqueio: 'removidos (streams incorretos são filtrados)',
          link_com_conta: o.temConta, erro_conta: o.erro, addons_com_stream: o.lista.map((a) => a.n),
        });
      }

      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(partes[1] || '');
        const id = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return json({ streams: [] });
        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
        const listas = await Promise.all(origens.lista.map((a) => streamsDe(a.u, tipo, id)));
        const itens = [];
        origens.lista.forEach((a, k) => listas[k].forEach((s) => itens.push({ s, origem: a.n })));
        const log = [];
        let streams;
        if (TMDB_KEY && SECRET) {
          const t0 = Date.now();
          const info = await infoTMDB(id, tipo).catch(() => undefined);
          const rt = info ? info.min : undefined;
          // título que só estreia no futuro: qualquer arquivo disponível agora é provavelmente falso
          const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
          const lanc = info && /^\d{4}-\d{2}-\d{2}$/.test(info.lancamento || '') ? info.lancamento : '';
          const naoLancado = !!lanc && lanc > amanha;
          const dataBR = lanc ? lanc.split('-').reverse().join('/') : '';
          let ver = { resultados: new Map(), semTempo: 0 };
          if (rt && !naoLancado) {
            const orcamento = Math.max(2500, Math.min(ORCAMENTO_MS, 12000 - (Date.now() - t0)));
            ver = await verificarLista(itens, id, tipo, rt, ctx, orcamento);
          }
          
          const streamsProcessados = await Promise.all(itens.map(async (it) => {
            const v = ver.resultados.get(it);
            const nome = String(it.s.name || it.s.title || 'Stream').replace(/\s+/g, ' ').slice(0, 60);
            let situacao;
            if (!ehDireto(it.s)) situacao = 'não é link direto (duração não medida)';
            else if (!rt) situacao = 'TMDB sem duração';
            else if (!v) situacao = 'duração não medida (tempo ou limite de links)';
            else if (v.status === 'nao_verificado') situacao = 'não deu para ler a duração do arquivo';
            else situacao = `${v.status.toUpperCase()} (${v.texto || `arquivo ${v.arquivoMin} min, TMDB${v.tmdbMin} min`})`;
            let marca = null;
            if (naoLancado) {
              marca = { rotulo: 'NÃO LANÇADO', texto: `este título só estreia em ${dataBR}; um arquivo disponível agora é provavelmente falso` };
              situacao = `NÃO LANÇADO (estreia em ${dataBR})`;
            } else if (v && v.status === 'errado') marca = v.por ? { por: v.por, texto: v.texto } : { por: 'duração', texto: `o arquivo tem ${v.arquivoMin} min e o filme tem ${v.tmdbMin} min` };
            else if (!v || v.status === 'nao_verificado') { // duração indisponível
              const bh = it.s.behaviorHints || {};
              if (!ehDireto(it.s) && bh.videoHash && bh.videoSize) { // torrent/addon que informa o hash: pergunta ao site externo
                const ext = await autenticidadePorHash(String(bh.videoHash), Number(bh.videoSize), id).catch(() => null);
                if (ext && ext.status === 'errado') { marca = { por: ext.por, texto: ext.texto }; situacao = `ERRADO (${ext.texto})`; }
                else if (ext && ext.status === 'ok') situacao = `OK (${ext.texto})`;
              }
              const motivo = !marca && info ? checarNome(it.s, tipo, id, info) : null;
              if (motivo) { marca = { por: 'nome do arquivo', texto: motivo }; situacao = `ERRADO pelo nome: ${motivo}`; }
              else if (nomeDoArquivo(it.s)) situacao += ` | nome "${nomeDoArquivo(it.s).slice(0, 70)}" sem sinais de erro`;
            }
            log.push(`[${it.origem}] ${nome} -> ${situacao}`);
            
            // Se tiver marca (não passou no teste), removemos o stream retornando null
            if (marca) return null;

            // Se passou, reescreve o link se necessário
            return await reescrever(it.s, base, tipo, id);
          }));

          streams = streamsProcessados.filter(Boolean);
          const removidos = itens.length - streams.length;
          console.log(`stream ${tipo} ${id}: ${itens.length} originais, ${streams.length} mantidos, ${removidos} removidos`);
          for (const l of log) console.log('[verif]', id, l);
        } else {
          streams = itens.map((it) => it.s);
        }
        return json(url.searchParams.get('log') ? { streams, log } : { streams });
      }

      if (partes[0] === 'play') {
        const dados = await lerToken(partes[1]);
        if (!dados || !/^https?:\/\//i.test(dados.u || '')) return texto(403, 'Link inválido');
        const v = await veredito(dados);
        console.log(`play ${dados.i} -> ${v.status}${v.texto ? ` (${v.texto})` : v.arquivoMin ? ` (arquivo ${v.arquivoMin} min, TMDB${v.tmdbMin} min)` : ''}`);
        if (url.searchParams.get('debug')) return json(v);
        if (v.status === 'errado') {
          return texto(404, `Vídeo incorreto: ${v.texto || `o arquivo tem ${v.arquivoMin} min e o filme deveria ter cerca de${v.tmdbMin} min`}.`);
        }
        return new Response(null, { status: 302, headers: { Location: dados.u, 'Cache-Control': 'no-store' } });
      }

      return json({ erro: 'não encontrado' }, 404);
    } catch (e) {
      console.error(e);
      return json({ streams: [] }, 500);
    }
  },
};

const LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAABmJLR0QA/wD/AP+gvaeTAAAgAElEQVR4nO2dd4AcZd3HP8/Mtit7l2vpPUCAEEoSCBCEhKJSBUsgKAr6CLJUBH31FQsqIIqKyisIvDbEBiJCAkhHhNBSSEIgCSmXdVwHwkqaWSv24a2W9u3bWae94+9Ta7sbZ3dmb2bzx/J7syz8/xld76/ecrq+T3g4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OD