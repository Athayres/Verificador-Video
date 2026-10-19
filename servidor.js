/**
 * Verificador + Detector de marca d'água num programa só (Node 20+), para Northflank, Render ou qualquer host Node.
 *
 *  - index.js  = o addon do Cloudflare Worker, SEM nenhuma alteração (roda aqui por um adaptador).
 *  - server.js = o detector de marca d'água (ffmpeg). Responde neste mesmo processo em /analisar, /info e /health.
 *  - O Worker chama o detector por MARCA_URL; aqui isso é automático (http://127.0.0.1:PORTA), sem segredo para combinar.
 *
 * Variáveis (Northflank > Environment), as mesmas do Worker:
 *   TMDB_KEY (obrigatória)   SECRET (use o MESMO valor de antes, senão os links instalados deixam de valer)
 *   OPENSUBTITLES_KEY, INCORRETOS, SO_AUTENTICADOS, BITRATE_MIN, TOLERANCIA... (opcionais, como no index.js)
 *   PUBLIC_URL (opcional; sem ela o addon usa o endereço com que foi chamado)
 *   PORT (padrão 10000; no Northflank declare a mesma porta em Networking)
 *   MARCA_SEGREDO / MARCA_URL: não precisa definir (o programa cria sozinho e usa só por dentro).
 *   MAX_PARALELO, MARCA_LIMITE, MARCA_QUADRO_MS: opcionais (ver server.js).
 *   KV_ARQUIVO (opcional): caminho de um arquivo JSON para guardar o cache entre reinícios (precisa de volume; sem ele o cache fica na memória).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const PORTA = Number(process.env.PORT) || 10000;

// O detector lê o segredo ao ser carregado, então o definimos ANTES de importar.
if (!process.env.MARCA_SEGREDO) process.env.MARCA_SEGREDO = crypto.randomBytes(24).toString('hex');
if (!process.env.MARCA_URL) process.env.MARCA_URL = `http://127.0.0.1:${PORTA}`;

const worker = (await import('./index.js')).default;
const marca = await import('./server.js');

// ---------- "KV" simples (o Worker usa para cache e para guardar o último link; funciona sem ele) ----------
class KVLocal {
  constructor(arquivo) {
    this.m = new Map();
    this.arquivo = arquivo || '';
    this.timer = null;
    if (this.arquivo) {
      try {
        const o = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
        const agora = Date.now();
        for (const [k, e] of Object.entries(o)) if (!e.exp || e.exp > agora) this.m.set(k, e);
      } catch { /* começa vazio */ }
    }
  }
  async get(chave, tipo) {
    const e = this.m.get(chave);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { this.m.delete(chave); return null; }
    const t = typeof tipo === 'string' ? tipo : tipo && tipo.type;
    if (t === 'json') { try { return JSON.parse(e.v); } catch { return null; } }
    return e.v;
  }
  async put(chave, valor, op) {
    if (this.m.size >= 5000) { const agora = Date.now(); for (const [k, e] of this.m) if (e.exp && e.exp < agora) this.m.delete(k); if (this.m.size >= 5000) this.m.clear(); }
    const ttl = op && Number(op.expirationTtl) > 0 ? Number(op.expirationTtl) : 0;
    this.m.set(chave, { v: String(valor), exp: ttl ? Date.now() + ttl * 1000 : 0 });
    this.salvar();
  }
  async delete(chave) { this.m.delete(chave); this.salvar(); }
  salvar() {
    if (!this.arquivo || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.m))); } catch (e) { console.error('KV_ARQUIVO: não consegui gravar:', e.message); }
    }, 5000);
  }
}

const env = Object.assign({}, process.env, { KV: new KVLocal(process.env.KV_ARQUIVO) });
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };

// ---------- Node (req/res) <-> Web (Request/Response) ----------
const PULAR = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
async function paraRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORTA}`).split(',')[0].trim();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (PULAR.has(k) || v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const partes = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 2e6) break; partes.push(c); }
    init.body = Buffer.concat(partes);
  }
  return new Request(`${proto}://${host}${req.url}`, init);
}

async function enviar(req, res, r) {
  const h = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-encoding' && k !== 'content-length') h[k] = v; });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) h['set-cookie'] = sc;
  res.writeHead(r.status, h);
  if (!r.body || req.method === 'HEAD') return res.end();
  const fluxo = Readable.fromWeb(r.body);
  fluxo.on('error', () => res.destroy());
  res.on('close', () => fluxo.destroy());
  fluxo.pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/health' || pathname === '/analisar' || pathname === '/info') return await marca.tratarMarca(req, res);
    const r = await worker.fetch(await paraRequest(req), env, ctx);
    return await enviar(req, res, r);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Erro interno'); } else res.destroy();
  }
});
servidor.keepAliveTimeout = 65000; // maior que o do proxy do host, evita 502 esporádico
servidor.headersTimeout = 70000;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

servidor.listen(PORTA, '0.0.0.0', () => {
  console.log(`Verificador + marca d'água no ar na porta ${PORTA}`);
  if (!process.env.TMDB_KEY) console.warn('ATENÇÃO: defina TMDB_KEY (e SECRET) nas variáveis de ambiente.');
  marca.ffmpegOk().then((ok) => console.log(ok ? 'ffmpeg pronto' : 'ffmpeg NÃO encontrado (a marca d\'água fica indisponível)'));
});
