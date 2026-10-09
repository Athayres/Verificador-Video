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
  let titulo = '';
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
    else if (id.v === 0x7BA9) { try { titulo = td.decode(corpo); } catch { /* ignora */ } }
    else if (id.v === 0x4489 && (corpo.length === 4 || corpo.length === 8)) {
      const dv = new DataView(corpo.buffer, corpo.byteOffset, corpo.byteLength);
      dur = corpo.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
    }
    p += sz.v;
  }
  return { seg: dur != null && Number.isFinite(dur) ? (dur * escala) / 1e9 : null, titulo };
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

const resumoOS = (a) => (a && a.length) ? a.slice(0, 3).map((x) => `${x.titulo || '?'} (${x.serie || x.imdb || '?'})`).join('; ') : 'hash desconhecido no OpenSubtitles';

// lista de títulos que o OpenSubtitles conhece para esse hash ([] = hash desconhecido; undefined = consulta falhou)
async function consultarOpenSubtitles(hash, tamanho) {
  const c = await cLer('os', hash);
  if (c !== undefined) { console.log(`[opensubtitles] ${hash} (cache): ${resumoOS(c)}`); return c; }
  let achados;
  try {
    if (OS_KEY) {
      const r = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?moviehash=${hash}`, {
        headers: { 'Api-Key': OS_KEY, 'User-Agent': 'VerificadorDuracao v1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) { console.log(`[opensubtitles] ${hash}: consulta falhou (HTTP ${r.status}, API nova)`); return undefined; }
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
      if (!r.ok) { console.log(`[opensubtitles] ${hash}: consulta falhou (HTTP ${r.status}, endereço antigo sem chave)`); return undefined; }
      const j = await r.json();
      achados = (Array.isArray(j) ? j : []).filter((x) => x.MatchedBy === 'moviehash').map((x) => ({
        imdb: ttDe(x.IDMovieImdb), serie: ttDe(x.SeriesIMDBParent), titulo: x.MovieName || '',
      }));
    }
  } catch (e) { console.log(`[opensubtitles] ${hash}: consulta falhou (${String((e && e.message) || e)})`); return undefined; }
  await cGravar('os', hash, achados);
  console.log(`[opensubtitles] ${hash}: ${resumoOS(achados)}`);
  return achados;
}

// compara o que o OpenSubtitles sabe sobre o hash com o título pedido
async function autenticidadePorHash(hash, tamanho, id) {
  const achados = await consultarOpenSubtitles(hash, tamanho);
  const POR = 'autenticidade, OpenSubtitles';
  if (!achados || !achados.length) { console.log(`[opensubtitles] ${id}: não verificado (${achados ? 'hash desconhecido' : 'consulta sem resposta'})`); return { status: 'nao_verificado' }; }
  const pedido = String(id).split(':')[0];
  console.log(`[opensubtitles] ${id}: pedido ${pedido}, OpenSubtitles diz ${resumoOS(achados)}`);
  if (achados.some((a) => a.imdb === pedido || a.serie === pedido)) return { status: 'ok', por: POR, texto: 'o arquivo é reconhecido como este título' };
  const a = achados.find((x) => x.imdb || x.serie);
  if (!a) return { status: 'nao_verificado' };
  return { status: 'errado', por: POR, texto: `este arquivo é conhecido como ${a.titulo ? `"${a.titulo}" ` : ''}(${a.serie || a.imdb}), não ${pedido}` };
}

async function autenticidadeDoLink(url, id) {
  try {
    const h = await hashDoArquivo(url);
    if (!h) { console.log(`[opensubtitles] ${id}: hash não calculado em ${hostDe(url)} (servidor sem Range ou arquivo pequeno)`); return { status: 'nao_verificado' }; }
    return await autenticidadePorHash(h.hash, h.tamanho, id);
  } catch { return { status: 'nao_verificado' }; }
}

// { min, total (bytes), titulo gravado } ou null se não deu para abrir o arquivo (min = null se a duração não foi lida)
async function duracaoArquivo(url) {
  try {
    const ini = await lerFaixa(url, 0, 65536);
    if (!ini || !ini.dados || ini.dados.length < 12) return null;
    const d = ini.dados;
    let seg = null;
    let titulo = '';
    let total = ini.total;
    if (d[0] === 0x23 && d[1] === 0x45 && d[2] === 0x58 && d[3] === 0x54 && d[4] === 0x4D && d[5] === 0x33 && d[6] === 0x55) { // '#EXTM3U' = HLS
      seg = await duracaoHLS(url);
      total = null;
    } else if (d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70) { // 'ftyp' = MP4/MOV
      seg = await duracaoMP4(url, ini);
    } else if (d[0] === 0x1A && d[1] === 0x45 && d[2] === 0xDF && d[3] === 0xA3) { // EBML = MKV/WebM
      let r = duracaoMKV(d);
      if ((!r || r.seg == null) && d.length >= 65536) {
        const mais = await lerFaixa(url, 0, 524288);
        if (mais && mais.dados) r = duracaoMKV(mais.dados) || r;
      }
      if (r) { seg = r.seg; titulo = r.titulo || ''; }
    }
    return { min: Number.isFinite(seg) && seg > 0 ? seg / 60 : null, total: total || null, titulo };
  } catch { return null; }
}

// compara o título gravado dentro do arquivo (MKV) com os títulos do filme; devolve o motivo ou null
const PALAVRAS_VAZIAS = new Set(['the', 'and', 'for', 'dos', 'das', 'del', 'uma', 'com', 'que']);
const palavrasDe = (t) => normalizar(t).split(' ').filter((w) => w.length > 2 && !PALAVRAS_VAZIAS.has(w));
function checarTituloGravado(titulo, info) {
  const t = String(titulo || '').trim();
  if (t.length < 4 || !info) return null;
  // lixo de release (site, qualidade, codificador) não é título: não conta
  if (/www\.|https?:|\.(com|net|org|to|cc|tv)\b|encod|releas|\brip\b|x26[45]|1080p|720p|2160p|blu-?ray|web-?dl|yts|rarbg|torrent/i.test(t)) return null;
  const doArquivo = palavrasDe(t);
  const doFilme = new Set(palavrasDe((info.titulos || []).join(' ')));
  if (!doArquivo.length || !doFilme.size) return null;
  if (doArquivo.some((w) => doFilme.has(w))) return null;
  return `o título gravado no arquivo é "${t.slice(0, 60)}" e o filme é "${(info.titulos || [])[0] || ''}"`;
}

// 'ok' | 'errado' | 'nao_verificado'  (só "errado" impede o vídeo de abrir)
async function veredito({ u, i, t }, rtConhecido) {
  const chave = `${i}|${t}|${u}`;
  const c = await cLer('vered', chave);
  if (c) return c;
  if (!TMDB_KEY) return { status: 'nao_verificado' };
  let r;
  try {
    const [info, arq] = await Promise.all([infoTMDB(i, t).catch(() => null), duracaoArquivo(u)]);
    const rt = info ? info.min : (rtConhecido || null);
    const dur = arq && arq.min;
    const tit = t === 'movie' && arq ? checarTituloGravado(arq.titulo, info) : null;
    const kbps = dur && arq.total ? (arq.total * 8) / (dur * 60) / 1000 : null;
    if (tit) {
      r = { status: 'errado', por: 'título gravado no arquivo', texto: tit };
    } else if (kbps !== null && dur > 20 && kbps < MIN_KBPS) {
      r = { status: 'errado', por: 'tamanho do arquivo', texto: `só ${Math.round(arq.total / 1048576)} MB para ${Math.round(dur)} min: pequeno demais, provavelmente não é o filme` };
    } else if (rt && dur) {
      const folga = Math.max(rt * (t === 'series' ? TOL * 1.5 : TOL), TOL_MIN);
      if (Math.abs(dur - rt) > folga) {
        r = { status: 'errado', tmdbMin: rt, arquivoMin: Math.round(dur) };
      } else {
        const ext = await autenticidadeDoLink(u, i); // duração bate: confirma pelo reconhecimento do arquivo
        r = ext.status === 'errado' ? ext : { status: 'ok', tmdbMin: rt, arquivoMin: Math.round(dur) };
      }
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
    const fora = (Array.isArray(j.x) ? j.x : []).filter((u) => typeof u === 'string').slice(0, 80).map(limparUrl);
    return k || a.length ? { k, a, x: fora } : null;
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

function recursoMeta(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { if (r === 'meta') return { types: m.types || [], prefixes: m.idPrefixes || [] }; }
    else if (r && r.name === 'meta') return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
  }
  return null;
}

// decide se o addon pode ser origem de vídeos: { rec } se sim, { ignorar: motivo } se não
function avaliarAddon(m) {
  if (!m) return { ignorar: 'inválido' };
  if (m.id === SELF_ID || RE_PROPRIO.test(m.name || '')) return { ignorar: 'é o próprio verificador' };
  if (RE_PARENTAL.test([m.id, m.name, m.description].join(' '))) return { ignorar: 'controle de impróprios' };
  const rec = recursoStream(m);
  if (!rec) return { ignorar: 'sem stream (só catálogo/metadados)' };
  return { rec };
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
  const ignorados = [];
  const metas = [];
  let posSelf = -1;
  for (const [idx, a] of j.result.addons.entries()) {
    if (!a || !a.manifest || !/^https?:/i.test(a.transportUrl || '')) continue;
    const ehSelf = a.manifest.id === SELF_ID || RE_PROPRIO.test(a.manifest.name || '');
    if (ehSelf && posSelf < 0) posSelf = idx;
    const rm = ehSelf ? null : recursoMeta(a.manifest);
    const av = avaliarAddon(a.manifest);
    // fonte de meta: só quem NÃO é fonte de vídeos (addon com meta + stream, como o BestCine, não entra)
    if (av.ignorar && rm) metas.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rm.types, prefixes: rm.prefixes, idx });
    if (av.ignorar) { ignorados.push(`${a.manifest.name || hostDe(a.transportUrl)} (${av.ignorar})`); continue; } // fora: o próprio verificador, controle de impróprios e quem não tem stream
    const rec = av.rec;
    lista.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rec.types, prefixes: rec.prefixes });
  }
  lista.ignorados = ignorados;
  lista.metas = posSelf >= 0 ? metas.filter((m) => m.idx > posSelf) : metas; // só os que ficam abaixo deste addon na ordem
  if (cacheContas.size >= 200) cacheContas.clear();
  cacheContas.set(authKey, { t: Date.now(), lista });
  return lista;
}

// addons de origem para este pedido: os da conta (filtrados por tipo e prefixo do id)
async function listaDeOrigens(cfgB64, host, tipo, id) {
  let lista = [];
  let erro = null;
  let ignorados = [];
  const puladas = [];
  const cfg = lerConfigConta(cfgB64);
  if (cfg) {
    lista = lista.concat(cfg.a); // lista gravada no próprio link (vale mesmo que o addon original seja desinstalado do Stremio)
    if (cfg.k) {
      try { const da = await addonsDaConta(cfg.k); ignorados = da.ignorados || []; lista = lista.concat(da); } catch (e) { erro = e.message; console.error('[conta Stremio]', e.message); }
    }
  }
  const fora = new Set(cfg ? cfg.x : []);
  lista = lista
    .filter((a) => { if (fora.has(a.u)) { puladas.push(`${a.n} (desmarcado em /configure)`); return false; } return true; }) // desmarcados na /configure
    .filter((a) => !RE_PROPRIO.test(a.n) && !RE_PARENTAL.test(a.n))      // links antigos que ainda os continham
    .filter((a) => {
      const ok = (!a.types.length || !tipo || a.types.includes(tipo)) && (!a.prefixes.length || !id || a.prefixes.some((p) => id.startsWith(p)));
      if (!ok) puladas.push(`${a.n} (não atende o tipo/id pedido)`);
      return ok;
    });
  const vistos = new Set();
  const final = lista
    .filter((a) => hostDe(a.u) !== host)          // nunca chama a si mesmo
    .filter((a) => !vistos.has(a.u) && vistos.add(a.u))
    .slice(0, 30);
  return { lista: final, erro, temConta: !!cfg, ignorados, puladas };
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

const PREFIXO = 'Vídeo incorreto : ';

// Nome mostrado no stream: "BestCine-autenticado" (passou na verificação) ou só "BestCine" (não deu para verificar).
// O resto do nome original (qualidade, resolução...) continua embaixo.
function rotuloOrigem(nomeOrig, origem, autenticado) {
  const linhas = String(nomeOrig || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (linhas.length && linhas[0].toLowerCase().startsWith(origem.toLowerCase())) {
    const resto = linhas[0].slice(origem.length).replace(/^[\s\-–:|·]+/, '');
    if (resto) linhas[0] = resto; else linhas.shift();
  }
  return [autenticado ? `${origem}-autenticado` : origem, ...linhas].join('\n');
}

// Troca o próprio nome do stream: "Batman A queda do morcego parte 2" vira "Vídeo incorreto : Batman A queda do morcego parte 2"
// (no nome e na 1ª linha do título/descrição) e acrescenta uma linha com o motivo.
function marcarIncorreto(s, m) {
  const motivo = m.rotulo ? `${m.rotulo}: ${m.texto}` : `${m.por}: ${m.texto}`;
  const base = s.description !== undefined ? s.description : s.title;
  const linhas = String(base || '').split('\n');
  const primeira = linhas.shift() || s.name || 'Stream';
  const texto = [PREFIXO + primeira, `⚠️ ${motivo}`, ...linhas].join('\n');
  return Object.assign({}, s, { name: PREFIXO + (s.name || 'Stream'), title: texto, description: texto });
}

// Bloqueio: o item deixa de ser tocável (sem url/infoHash/etc.) e vira um link externo para a página do título,
// então o Stremio não abre o player. Com BLOQUEAR_INCORRETOS=0 só renomeia (continua tocando).
function bloquearStream(s, m, imdb) {
  const marcado = marcarIncorreto(s, m);
  return { name: marcado.name, title: marcado.title, description: marcado.description, externalUrl: `https://www.imdb.com/title/${imdb}/` };
}

// ---------- addons de origem ----------
// Começo da resposta de erro de um addon (servidor + texto), para o painel mostrar POR QUE deu 403/530.
async function motivoDaFalha(r) {
  try {
    const t = (await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    const srv = r.headers.get('server') || '';
    const partes = [srv && `servidor: ${srv}`, t && `"${t}"`].filter(Boolean);
    const desafio = r.headers.get('cf-mitigated') ? ' [desafio da Cloudflare]' : '';
    return partes.length || desafio ? ` — ${partes.join(', ')}${desafio}` : '';
  } catch { return ''; }
}

async function streamsDe(base, tipo, id, nome, falhas, estat) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/stream/${tipo}/${encodeURIComponent(id)}.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const motivo = await motivoDaFalha(r);
      if (falhas) falhas.push(`${nome}: HTTP ${r.status}${motivo}`);
      if (estat) estat.set(base, { ms: Date.now() - t0, erro: `HTTP ${r.status}${motivo}` });
      console.error('origem HTTP', r.status, base);
      return [];
    }
    const j = await r.json();
    const arr = Array.isArray(j.streams) ? j.streams : [];
    if (estat) estat.set(base, { ms: Date.now() - t0, n: arr.length });
    return arr;
  } catch (e) {
    console.error('origem falhou:', base, e && e.message);
    if (falhas) falhas.push(`${nome}: ${(e && e.message) || 'erro'}`);
    if (estat) estat.set(base, { ms: Date.now() - t0, erro: e && e.name === 'TimeoutError' ? 'tempo esgotado (15 s)' : String((e && e.message) || 'erro') });
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

// ---------- troca de id (meta) ----------
// addons que têm meta e ficam abaixo deste na ordem da conta (o Stremio usaria o primeiro que respondesse)
async function fontesDeMeta(cfgB64, host, tipo, id) {
  const cfg = lerConfigConta(cfgB64);
  if (!cfg || !cfg.k) return { lista: [], erro: 'link sem conta do Stremio (gere o link em /configure)' };
  try {
    const da = await addonsDaConta(cfg.k);
    const lista = (da.metas || [])
      .filter((a) => hostDe(a.u) !== host)
      .filter((a) => !a.types.length || a.types.includes(tipo))
      .filter((a) => !a.prefixes.length || a.prefixes.some((p) => id.startsWith(p)))
      .slice(0, 4);
    return { lista, erro: null };
  } catch (e) { return { lista: [], erro: e.message }; }
}

async function metaDe(base, tipo, id, cabecalhos, ponte) {
  const t0 = Date.now();
  try {
    const alvo = `${base}/meta/${tipo}/${encodeURIComponent(id)}.json`;
    const r = ponte ? await ponte.fetch(alvo, { headers: cabecalhos }) : await fetch(alvo, { headers: cabecalhos, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const dica = /1042/.test(t) ? ' — código 1042: a Cloudflare não deixou um Worker chamar o outro; confira a opção global_fetch_strictly_public no wrangler.toml dos dois (ou crie a ligação de serviço CONTROLE)' : '';
      return { erro: `HTTP ${r.status}${dica}`, ms: Date.now() - t0 };
    }
    const j = await r.json();
    if (j && j.meta && typeof j.meta === 'object' && j.meta.id) return { meta: j.meta, ms: Date.now() - t0, via: ponte ? 'ligação interna' : '' };
    return { erro: 'respondeu sem meta', ms: Date.now() - t0 };
  } catch (e) { return { erro: e && e.name === 'TimeoutError' ? 'tempo esgotado (8 s)' : String((e && e.message) || 'erro'), ms: Date.now() - t0 }; }
}

// Completa o meta do Controle de Impróprios com o de outra fonte, só em campos de aparência que ele deixou vazios.
// Nunca mexe em id, vídeos nem behaviorHints: é por eles que o Controle bloqueia.
const CAMPOS_COMPLETAR = ['name', 'poster', 'background', 'logo', 'description', 'genres', 'runtime', 'releaseInfo', 'released', 'year', 'cast', 'director', 'writer', 'imdbRating', 'country', 'awards', 'website', 'trailers', 'language'];
function completarMeta(principal, outro) {
  const m = Object.assign({}, principal);
  const vazio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  const preenchidos = [];
  for (const c of CAMPOS_COMPLETAR) {
    if (vazio(m[c]) && !vazio(outro[c])) { m[c] = outro[c]; preenchidos.push(c); }
  }
  return { meta: m, preenchidos };
}

// troca tt... por vrf:tt... só onde o id ainda é tt (o que outro addon já trocou fica como está)
const ehTT = (v) => typeof v === 'string' && /^tt\d+(:\d+:\d+)?$/.test(v);
function trocarIds(meta, tipo) {
  const m = Object.assign({}, meta);
  const info = { videos: 0, filme: false };
  if (Array.isArray(m.videos)) {
    m.videos = m.videos.map((v) => {
      if (v && ehTT(v.id)) { info.videos++; return Object.assign({}, v, { id: 'vrf:' + v.id }); }
      return v;
    });
  }
  const bh = Object.assign({}, m.behaviorHints);
  if (ehTT(bh.defaultVideoId)) bh.defaultVideoId = 'vrf:' + bh.defaultVideoId;
  if (tipo === 'movie' && typeof m.id === 'string' && /^tt\d+$/.test(m.id)) {
    bh.defaultVideoId = 'vrf:' + m.id;
    if (MODO_FILME === 'trocar') m.id = 'vrf:' + m.id;
    info.filme = true;
  }
  if (Object.keys(bh).length) m.behaviorHints = bh;
  return { meta: m, info };
}

const cacheMeta = new Map();

// últimos pedidos (meta e stream), para ver em /ultimos sem abrir os logs da Cloudflare
const recentes = [];
async function registrar(linha) {
  const hora = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(11, 19); // horário de Brasília
  const l = `${hora}\n${linha}`;
  recentes.unshift(l); recentes.splice(30);
  if (!KV) return;
  try {
    const atual = JSON.parse((await KV.get('ultimos')) || '[]');
    atual.unshift(l); atual.splice(30);
    await KV.put('ultimos', JSON.stringify(atual));
  } catch { /* só um registro: se falhar, segue */ }
}
// Guarda o próprio link (com a config da conta) no KV, para o Controle de Impróprios achar este addon sem você configurar nada.
let linkGravado = '';
function gravarMeuLink(ctx, url, cfgB64) {
  if (!KV || !cfgB64) return;
  const cfg = lerConfigConta(cfgB64);
  if (!cfg || !cfg.k) return; // só o link com a conta do Stremio serve para o meta
  const link = `${url.origin}/${cfgB64}`;
  if (link === linkGravado) return;
  linkGravado = link;
  const p = Promise.resolve(KV.put('AUTENTICADO_URL', link)).catch(() => { linkGravado = ''; });
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

const guardar = (ctx, linha) => { const p = registrar(linha); if (ctx && ctx.waitUntil) ctx.waitUntil(p); };

function manifest(base) {
  return {
    id: 'community.verificador.duracao',
    version: '1.9.1',
    name: 'Autenticado', // é o nome do botão ao lado de "All" na lista de streams
    description: 'Lê os addons de vídeo da sua conta e mostra só os streams que passam no teste de duração (TMDB). Troca o id (vrf:) para só ele responder aos vídeos. Instale NO TOPO da lista de addons.',
    logo: `${base}/check_tempo.png`,
    resources: ['meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'vrf:'],
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
<p>Entre com a sua conta do Stremio. O verificador lê sozinho os addons de vídeo da conta. O e-mail e a senha vão direto para o Stremio, não passam por este servidor.</p>
<input type="email" id="email" placeholder="E-mail do Stremio" autocomplete="username">
<input type="password" id="senha" placeholder="Senha" autocomplete="current-password">
<button onclick="entrar()">Gerar link</button>
</div>
<div id="msg"></div>
<div id="resultado" style="display:none">
<p>Instale o link abaixo. <b>Depois você pode desinstalar os addons marcados no Stremio</b>: o verificador guarda os endereços deles no próprio link, e assim os vídeos deles não aparecem duplicados.</p>
<input type="text" id="link" readonly onclick="this.select()">
<button onclick="copiar()">Copiar link</button>
<button class="sec" onclick="instalar()">Instalar no Stremio (app)</button>
<button class="sec" onclick="instalarWeb()">Instalar no Stremio Web</button>
</div></div>
<script>
var SELF_ID=${JSON.stringify(SELF_ID)};
var RE_PROPRIO=new RegExp(${JSON.stringify(RE_PROPRIO.source)},'i');
var RE_PARENTAL=new RegExp(${JSON.stringify(RE_PARENTAL.source)},'i');
var caminho='', AUTH='';
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
function avaliar(m){
  if(m.id===SELF_ID||RE_PROPRIO.test(m.name||''))return{self:true};
  if(RE_PARENTAL.test([m.id,m.name,m.description].join(' ')))return{ign:'controle de impróprios'};
  var rec=temStream(m);
  if(!rec)return{ign:'só catálogo/metadados, sem vídeos'};
  return{rec:rec};
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
    var sel=[];
    c.result.addons.forEach(function(a){
      var m=a.manifest||{};
      if(!/^https?:/i.test(a.transportUrl||''))return;
      var av=avaliar(m);
      if(av.ign||av.self)return;
      sel.push({n:m.name||a.transportUrl,u:limpar(a.transportUrl),t:av.rec.t,p:av.rec.p});
    });
    var cfg={a:sel,k:AUTH};
    caminho=location.host+'/'+b64u(JSON.stringify(cfg))+'/manifest.json';
    document.getElementById('link').value=location.protocol+'//'+caminho;
    document.getElementById('passo1').style.display='none';
    document.getElementById('resultado').style.display='block';
    msg('Pronto: '+sel.length+' addon(s) com stream. Copie o link ou instale direto.');
  }catch(e){msg('Erro: '+e.message)}
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
      const RESERVADOS = ['configure', 'manifest.json', 'meta', 'stream', 'play', 'health', 'diagnostico', 'ultimos', 'check_tempo.png'];
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift(); // /<config>/manifest.json, /<config>/stream/...
      if (['manifest.json', 'meta', 'stream'].includes(partes[0])) gravarMeuLink(ctx, url, cfgB64);
      if (partes[0] === 'health') return json({ ok: true });
      if (partes[0] === 'configure') return paginaConfig();
      if (partes[0] === 'manifest.json') return json(manifest(base));

      if (partes[0] === 'check_tempo.png') {
        return new Response(b64uParaBytes(LOGO_B64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (partes[0] === 'ultimos') { // últimos pedidos do Stremio a este addon (mais novo primeiro)
        let lista = recentes;
        if (KV) { try { const l = JSON.parse((await KV.get('ultimos')) || '[]'); if (l.length) lista = l; } catch { /* usa a memória */ } }
        return texto(200, lista.length ? lista.join('\n\n') : 'Nada registrado ainda. Abra um filme ou série no Stremio e atualize esta página (pode levar até 1 minuto).');
      }

      if (partes[0] === 'diagnostico') { // mostra se as configurações foram lidas (nunca mostra as chaves)
        let tmdbTeste = 'TMDB_KEY não definida';
        if (TMDB_KEY) {
          try { await tmdb('/configuration'); tmdbTeste = 'ok'; } catch (e) { tmdbTeste = 'falhou: ' + String((e && e.message) || e); }
        }
        const o = await listaDeOrigens(cfgB64, url.hostname, null, null);
        const mf = await fontesDeMeta(cfgB64, url.hostname, 'movie', 'tt0000001');
        // /diagnostico?testar=tt5537002 (&tipo=series): pede o meta a cada fonte e mostra o que ela responde
        let testeMeta;
        const idT = url.searchParams.get('testar') || '';
        if (/^tt\d+$/.test(idT)) {
          const tipoT = url.searchParams.get('tipo') === 'series' ? 'series' : 'movie';
          const fontesT = await fontesDeMeta(cfgB64, url.hostname, tipoT, idT);
          testeMeta = await Promise.all(fontesT.lista.map(async (a) => {
            const t0 = Date.now();
            try {
              const ponte = RE_PARENTAL.test(a.n) ? CONTROLE_BIND : null;
              const alvoT = `${a.u}/meta/${tipoT}/${idT}.json`;
              const r = ponte ? await ponte.fetch(alvoT, { headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Via': 'autenticado' } }) : await fetch(alvoT, { headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Via': 'autenticado' }, signal: AbortSignal.timeout(8000) });
              const txt = await r.text();
              let desc = '';
              try { const jj = JSON.parse(txt); desc = String((jj.meta && jj.meta.description) || '').slice(0, 300); } catch { /* não é JSON */ }
              return { addon: a.n, site: hostDe(a.u), status: r.status, ms: Date.now() - t0, resposta_inicio: txt.slice(0, 300), descricao_do_meta: desc };
            } catch (e) { return { addon: a.n, site: hostDe(a.u), erro: String((e && e.message) || e), ms: Date.now() - t0 }; }
          }));
        }
        return json({
          tmdb_key_definida: !!TMDB_KEY, tmdb_teste: tmdbTeste, secret_definido: !!SECRET, kv_ligado: !!KV,
          opensubtitles: OS_KEY ? 'com chave' : 'sem chave (endereço antigo)',
          reprovados: MODO === 'ocultar' ? 'removidos da lista' : MODO === 'bloquear' ? 'aparecem bloqueados (não tocam)' : 'aparecem marcados (continuam tocando)',
          link_com_conta: o.temConta, erro_conta: o.erro, addons_com_stream: o.lista.map((a) => a.n),
          prefixos_dos_addons_de_stream: o.lista.map((a) => `${a.n}: ${a.prefixes.length ? a.prefixes.join(', ') : 'SEM idPrefixes (o Stremio pede qualquer id a ele, inclusive vrf:)'}`), fora_da_lista: o.ignorados, fontes_de_meta: mf.lista.map((a) => a.n), teste_meta: testeMeta, ligacao_controle: CONTROLE_BIND ? 'ativa (ligação de serviço)' : 'não usada (chamando pelo endereço normal)', erro_meta: mf.erro, id_filme: MODO_FILME,
        });
      }

      if (partes[0] === 'meta') {
        const tipo = decodeURIComponent(partes[1] || '');
        const idPed = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        const idTT = idPed.replace(/^vrf:/, '');
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(idTT)) return json({ err: 'id não suportado' }, 404);
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ua = request.headers.get('User-Agent') || UA;
        const cab = { 'User-Agent': ua, Accept: 'application/json', 'X-Via': 'autenticado' }; // repassa o aparelho (o Controle separa por IP/UA); X-Via evita que o Controle chame de volta
        const viaControle = /controle/i.test(request.headers.get('X-Via') || ''); // pedido vindo do Controle: não chama o Controle de volta
        if (ip) { cab['X-Forwarded-For'] = ip; cab['X-Real-IP'] = ip; }
        const chaveC = `${cfgB64.slice(-16)}|${MODO_FILME}|${viaControle ? 'c' : ''}|${tipo}|${idTT}|${ip}|${ua}`;
        const emC = cacheMeta.get(chaveC);
        if (emC && Date.now() - emC.t < 5 * 60 * 1000) return json({ meta: emC.meta });
        const painel = [`meta ${tipo} ${idPed}`];
        const f = await fontesDeMeta(cfgB64, url.hostname, tipo, idTT);
        if (viaControle) f.lista = f.lista.filter((a) => !RE_PARENTAL.test(a.n));
        if (f.erro) painel.push(`  ! ${f.erro}`);
        const cabPonte = Object.assign({}, cab, ip ? { 'CF-Connecting-IP': ip } : {});
        const tent = f.lista.map((a) => { const ponte = RE_PARENTAL.test(a.n) ? CONTROLE_BIND : null; return metaDe(a.u, tipo, idTT, ponte ? cabPonte : cab, ponte); }); // em paralelo; vale o primeiro da ordem que responder
        let achado = null;
        for (let k = 0; k < tent.length; k++) {
          const r = await tent[k];
          if (r.meta) {
            achado = r.meta;
            let extra = '';
            if (RE_PARENTAL.test(f.lista[k].n) && k + 1 < tent.length) { // Controle: junta com a próxima fonte que responder (até 1,5 s)
              const resto = await Promise.race([Promise.all(tent.slice(k + 1)), new Promise((res) => setTimeout(() => res(null), 1500))]);
              const o = resto && resto.findIndex((x) => x && x.meta);
              if (resto && o >= 0) {
                const c = completarMeta(achado, resto[o].meta);
                achado = c.meta;
                if (c.preenchidos.length) extra = `; completado com ${f.lista[k + 1 + o].n}: ${c.preenchidos.join(', ')}`;
              }
            }
            painel.push(`  ✔ ${f.lista[k].n}: meta recebido (${r.ms} ms${r.via ? `, ${r.via}` : ''}) — usado${extra}`);
            break;
          }
          painel.push(`  ✘ ${f.lista[k].n}: ${r.erro} (${r.ms} ms)`);
        }
        if (!achado) {
          painel.push(f.lista.length ? '  = nenhuma fonte deu meta: o Stremio segue para o próximo addon (sem troca de id)' : '  = nenhum addon de meta abaixo deste na ordem: sem troca de id');
          console.log('[meta] ' + painel.join('\n'));
          guardar(ctx, painel.join('\n'));
          return json({ err: 'sem fonte de meta' }, 404);
        }
        const tr = trocarIds(achado, tipo);
        painel.push(`  = ids trocados: ${tr.info.videos} vídeo(s)${tr.info.filme ? `; filme (${MODO_FILME === 'trocar' ? 'id + defaultVideoId' : 'só defaultVideoId'})` : ''}`);
        console.log('[meta] ' + painel.join('\n'));
        guardar(ctx, painel.join('\n'));
        if (cacheMeta.size >= 500) cacheMeta.clear();
        cacheMeta.set(chaveC, { t: Date.now(), meta: tr.meta });
        return json(url.searchParams.get('log') ? { painel, meta: tr.meta } : { meta: tr.meta });
      }

      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(partes[1] || '');
        const idPed = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        const id = idPed.replace(/^vrf:/, ''); // vem vrf:tt... quando o meta passou por aqui
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return json({ streams: [] });
        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
        const falhas = [];
        const estat = new Map();
        const tally = new Map(); // por addon: aprovados, reprovados (e por quê), sem medir
        const listas = await Promise.all(origens.lista.map((a) => streamsDe(a.u, tipo, id, a.n, falhas, estat)));
        const itens = [];
        origens.lista.forEach((a, k) => listas[k].forEach((s) => itens.push({ s, origem: a.n })));
        const log = falhas.map((f) => `[falhou] ${f}`);
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
          let reprovados = 0;
          streams = (await Promise.all(itens.map(async (it) => {
            let s = await reescrever(it.s, base, tipo, id);
            const v = ver.resultados.get(it);
            const nome = String(it.s.name || it.s.title || 'Stream').replace(/\s+/g, ' ').slice(0, 60);
            let situacao;
            if (!ehDireto(it.s)) situacao = 'não é link direto (duração não medida)';
            else if (!rt) situacao = 'TMDB sem duração';
            else if (!v) situacao = 'duração não medida (tempo ou limite de links)';
            else if (v.status === 'nao_verificado') situacao = 'não deu para ler a duração do arquivo';
            else situacao = `${v.status.toUpperCase()} (${v.texto || `arquivo ${v.arquivoMin} min, TMDB ${v.tmdbMin} min`})`;
            let marca = null;
            let autenticado = !!(v && v.status === 'ok');
            if (naoLancado) {
              marca = { rotulo: 'NÃO LANÇADO', texto: `este título só estreia em ${dataBR}; um arquivo disponível agora é provavelmente falso` };
              situacao = `NÃO LANÇADO (estreia em ${dataBR})`;
            } else if (v && v.status === 'errado') marca = v.por ? { por: v.por, texto: v.texto } : { por: 'duração', texto: `o arquivo tem ${v.arquivoMin} min e o filme tem ${v.tmdbMin} min` };
            else if (!v || v.status === 'nao_verificado') { // duração indisponível
              const bh = it.s.behaviorHints || {};
              if (!ehDireto(it.s) && bh.videoHash && bh.videoSize) { // torrent/addon que informa o hash: pergunta ao site externo
                const ext = await autenticidadePorHash(String(bh.videoHash), Number(bh.videoSize), id).catch(() => null);
                if (ext && ext.status === 'errado') { marca = { por: ext.por, texto: ext.texto }; situacao = `ERRADO (${ext.texto})`; }
                else if (ext && ext.status === 'ok') { situacao = `OK (${ext.texto})`; autenticado = true; }
              }
              const motivo = !marca && info ? checarNome(it.s, tipo, id, info) : null;
              if (motivo) { marca = { por: 'nome do arquivo', texto: motivo }; situacao = `ERRADO pelo nome: ${motivo}`; }
              else if (nomeDoArquivo(it.s)) situacao += ` | nome "${nomeDoArquivo(it.s).slice(0, 70)}" sem sinais de erro`;
            }
            log.push(`[${it.origem}] ${nome} -> ${situacao}`);
            const T = tally.get(it.origem) || (tally.set(it.origem, { ok: 0, reprov: 0, semMedir: 0, motivos: {} }), tally.get(it.origem));
            if (!marca) { if (v && v.status === 'ok') T.ok++; else T.semMedir++; }
            else { T.reprov++; const mo = marca.por || marca.rotulo || 'outro'; T.motivos[mo] = (T.motivos[mo] || 0) + 1; }
            if (marca) {
              reprovados++;
              if (MODO === 'ocultar') return null; // só fica na lista quem passou no teste
              s = MODO === 'bloquear' ? bloquearStream(it.s, marca, id.split(':')[0]) : marcarIncorreto(s, marca);
            } else {
              s = Object.assign({}, s, { name: rotuloOrigem(it.s.name, it.origem, autenticado) });
            }
            return s;
          }))).filter(Boolean);
          console.log(`stream ${tipo} ${id}: ${streams.length} na lista, TMDB ${rt || '?'} min, ${reprovados} reprovados (${MODO})`);
          for (const l of log) console.log('[verif]', id, l);
        } else {
          streams = itens.map((it) => it.s);
        }
        const painel = [`${tipo} ${idPed}`];
        origens.lista.forEach((a) => {
          const e = estat.get(a.u) || {};
          const T = tally.get(a.n);
          if (e.erro) painel.push(`  ✘ ${a.n}: ${e.erro} (${e.ms} ms)`);
          else if (!e.n) painel.push(`  ○ ${a.n}: respondeu, mas sem streams (${e.ms} ms)`);
          else {
            const mot = T && T.reprov ? ` [${Object.entries(T.motivos).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
            painel.push(`  ✔ ${a.n}: ${e.n} streams (${e.ms} ms)` + (T ? ` → ${T.ok} aprovados, ${T.reprov} reprovados${mot}, ${T.semMedir} sem medir` : ' (sem verificação: falta TMDB_KEY/SECRET)'));
          }
        });
        if (!origens.lista.length) painel.push('  nenhum addon de stream consultado');
        if (origens.puladas.length) painel.push(`  – pulados neste pedido: ${origens.puladas.join('; ')}`);
        if (origens.ignorados.length) painel.push(`  – fora da lista: ${origens.ignorados.join('; ')}`);
        if (origens.erro) painel.push(`  ! conta do Stremio: ${origens.erro}`);
        else if (!origens.temConta) painel.push('  ! link sem conta/lista de addons: gere o link em /configure');
        painel.push(`  = na lista final: ${streams.length} streams`);
        console.log('[painel] ' + painel.join('\n'));
        guardar(ctx, painel.join('\n'));
        return json(url.searchParams.get('log') ? { painel, streams, log } : { streams });
      }

      if (partes[0] === 'play') {
        const dados = await lerToken(partes[1]);
        if (!dados || !/^https?:\/\//i.test(dados.u || '')) return texto(403, 'Link inválido');
        const v = await veredito(dados);
        console.log(`play ${dados.i} -> ${v.status}${v.texto ? ` (${v.texto})` : v.arquivoMin ? ` (arquivo ${v.arquivoMin} min, TMDB ${v.tmdbMin} min)` : ''}`);
        if (url.searchParams.get('debug')) return json(v);
        if (v.status === 'errado') {
          return texto(404, `Vídeo incorreto: ${v.texto || `o arquivo tem ${v.arquivoMin} min e o filme deveria ter cerca de ${v.tmdbMin} min`}.`);
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

const LOGO_B64 = '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';
