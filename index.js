/**
 * Agregador de Addons do Stremio – Cloudflare Worker
 * Versão sem verificação de duração (todos os streams passam livremente).
 */
const SELF_ID = 'community.verificador.duracao';
const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TTL = 24 * 3600 * 1000;

// Addons que NUNCA entram como origem de vídeos
const RE_PROPRIO = /verificador de dura[cç][aã]o|^\s*autenticado\s*$/i;
const RE_PARENTAL = /controle de impr[oó]prios?|guia dos pais|parents?[ _-]?guide|parental|classifica[cç][aã]o indicativa|content[ _-]?(advisory|rating|warning)|age[ _-]?(rating|gate|block)/i;

let PUBLIC_URL = '';
let SECRET = '';
let KV = null;
let ATRASO_STREAM_MS = 3000;
let MODO_FILME = 'trocar';
let CONTROLE_BIND = null;

async function carregarConfig(env) {
  KV = env.KV || null;
  const ler = async (nome) => {
    let v = String(env[nome] || '').trim();
    if (!v && KV) { try { v = String((await KV.get(nome, { cacheTtl: 300 })) || '').trim(); } catch {} }
    return v;
  };
  PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  SECRET = (await ler('SECRET')) || 'segredo_padrao';
  const atrasoBruto = await ler('ATRASO_STREAM_MS');
  const atrasoNumerico = atrasoBruto === '' ? 3000 : Number(atrasoBruto);
  ATRASO_STREAM_MS = Number.isFinite(atrasoNumerico) ? Math.max(0, Math.min(10000, Math.floor(atrasoNumerico))) : 3000;
  MODO_FILME = String((await ler('ID_FILME')) || '').toLowerCase() === 'dica' ? 'dica' : 'trocar';
  CONTROLE_BIND = env.CONTROLE && typeof env.CONTROLE.fetch === 'function' ? env.CONTROLE : null;
}

// ---------- Links assinados para redirecionamento de reprodução ----------
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

// ---------- Caches ----------
const mem = { streams: new Map() };
async function hashCurto(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  return Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Cache rápida da lista completa de streams (TTL de 5 minutos)
async function cLerStream(chave) {
  const m = mem.streams;
  const e = m.get(chave);
  if (e && Date.now() - e.t < 5 * 60 * 1000) return e.v;
  if (e) m.delete(chave);
  return undefined;
}
async function cGravarStream(chave, v) {
  const m = mem.streams;
  if (m.size >= 1000) m.clear();
  m.set(chave, { v, t: Date.now() });
}

// ---------- Lista de addons da conta do Stremio ----------
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
  if (!j.result || !Array.isArray(j.result.addons)) throw new Error('sessão do Stremio inválida ou expirada');
  const lista = [];
  const ignorados = [];
  const metas = [];
  const catalogos = [];
  let posSelf = -1;
  for (const [idx, a] of j.result.addons.entries()) {
    if (!a || !a.manifest || !/^https?:/i.test(a.transportUrl || '')) continue;
    const ehSelf = a.manifest.id === SELF_ID || RE_PROPRIO.test(a.manifest.name || '');
    if (ehSelf && posSelf < 0) posSelf = idx;
    const rm = ehSelf ? null : recursoMeta(a.manifest);
    const av = avaliarAddon(a.manifest);
    if (!ehSelf) {
      const cat = (a.manifest.catalogs || []).find((c) => c && c.type === 'movie' && !(c.extra || []).some((e) => e && e.isRequired));
      if (cat) catalogos.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), id: cat.id, nome: cat.name || cat.id });
    }
    if (av.ignorar && rm) metas.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rm.types, prefixes: rm.prefixes, idx });
    if (av.ignorar) { ignorados.push(`${a.manifest.name || hostDe(a.transportUrl)} (${av.ignorar})`); continue; }
    const rec = av.rec;
    lista.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rec.types, prefixes: rec.prefixes });
  }
  lista.ignorados = ignorados;
  lista.catalogos = catalogos;
  lista.metas = posSelf >= 0 ? metas.filter((m) => m.idx > posSelf) : metas;
  if (cacheContas.size >= 200) cacheContas.clear();
  cacheContas.set(authKey, { t: Date.now(), lista });
  return lista;
}

async function listaDeOrigens(cfgB64, host, tipo, id) {
  let lista = [];
  let erro = null;
  let ignorados = [];
  const puladas = [];
  const cfg = lerConfigConta(cfgB64);
  if (cfg) {
    lista = lista.concat(cfg.a);
    if (cfg.k) {
      try { const da = await addonsDaConta(cfg.k); ignorados = da.ignorados || []; lista = lista.concat(da); } catch (e) { erro = e.message; }
    }
  }
  const fora = new Set(cfg ? cfg.x : []);
  lista = lista
    .filter((a) => { if (fora.has(a.u)) { puladas.push(`${a.n} (desmarcado)`); return false; } return true; })
    .filter((a) => !RE_PROPRIO.test(a.n) && !RE_PARENTAL.test(a.n))
    .filter((a) => {
      const ok = (!a.types.length || !tipo || a.types.includes(tipo)) && (!a.prefixes.length || !id || a.prefixes.some((p) => id.startsWith(p)));
      if (!ok) puladas.push(`${a.n} (não atende o tipo/id)`);
      return ok;
    });
  const vistos = new Set();
  const final = lista
    .filter((a) => hostDe(a.u) !== host)
    .filter((a) => !vistos.has(a.u) && vistos.add(a.u))
    .slice(0, 30);
  return { lista: final, erro, temConta: !!cfg, ignorados, puladas };
}

// Organiza o rótulo da origem no stream (ex: "FenixFlix - Qualidade...")
function rotuloOrigem(nomeOrig, origem) {
  const linhas = String(nomeOrig || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (linhas.length && linhas[0].toLowerCase().startsWith(origem.toLowerCase())) {
    const resto = linhas[0].slice(origem.length).replace(/^[\s\-–:|·]+/, '');
    if (resto) linhas[0] = resto; else linhas.shift();
  }
  return [origem, ...linhas].join('\n');
}

// ---------- Chamadas aos addons de origem ----------
async function motivoDaFalha(r) {
  try {
    const t = (await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    const srv = r.headers.get('server') || '';
    const partes = [srv && `servidor: ${srv}`, t && `"${t}"`].filter(Boolean);
    const desafio = r.headers.get('cf-mitigated') ? ' [desafio Cloudflare]' : '';
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
      return [];
    }
    const j = await r.json();
    const arr = Array.isArray(j.streams) ? j.streams : [];
    if (estat) estat.set(base, { ms: Date.now() - t0, n: arr.length });
    return arr;
  } catch (e) {
    if (falhas) falhas.push(`${nome}: ${(e && e.message) || 'erro'}`);
    if (estat) estat.set(base, { ms: Date.now() - t0, erro: e && e.name === 'TimeoutError' ? 'timeout (15s)' : String((e && e.message) || 'erro') });
    return [];
  }
}

async function reescrever(s, base, tipo, id) {
  const bh = s && s.behaviorHints;
  if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return s;
  if (bh && bh.proxyHeaders) return s;
  return Object.assign({}, s, { url: `${base}/play/${await criarToken({ u: s.url, i: id, t: tipo })}` });
}

// ---------- Troca de ID (Metas) ----------
async function fontesDeMeta(cfgB64, host, tipo, id) {
  const cfg = lerConfigConta(cfgB64);
  if (!cfg || !cfg.k) return { lista: [], erro: 'link sem conta do Stremio' };
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
    if (!r.ok) return { erro: `HTTP ${r.status}`, ms: Date.now() - t0 };
    const j = await r.json();
    if (j && j.meta && typeof j.meta === 'object' && j.meta.id) return { meta: j.meta, ms: Date.now() - t0 };
    return { erro: 'sem meta', ms: Date.now() - t0 };
  } catch (e) { return { erro: String((e && e.message) || 'erro'), ms: Date.now() - t0 }; }
}

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
const recentes = [];
async function registrar(linha) {
  const hora = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(11, 19);
  const l = `${hora}\n${linha}`;
  recentes.unshift(l); recentes.splice(30);
  if (!KV) return;
  try {
    const atual = JSON.parse((await KV.get('ultimos')) || '[]');
    atual.unshift(l); atual.splice(30);
    await KV.put('ultimos', JSON.stringify(atual));
  } catch {}
}

let linkGravado = '';
function gravarMeuLink(ctx, url, cfgB64) {
  if (!KV || !cfgB64) return;
  const cfg = lerConfigConta(cfgB64);
  if (!cfg || !cfg.k) return;
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
    version: '1.9.2',
    name: 'Autenticado',
    description: 'Agregador de addons do Stremio (sem filtros de duração).',
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
<title>Agregador Stremio</title>
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
<h2 style="text-align:center;margin:6px 0 12px">Agregador Stremio</h2>
<div id="passo1">
<p>Entre com a sua conta do Stremio para carregar os seus addons automaticamente.</p>
<input type="email" id="email" placeholder="E-mail do Stremio" autocomplete="username">
<input type="password" id="senha" placeholder="Senha" autocomplete="current-password">
<button onclick="entrar()">Gerar link</button>
</div>
<div id="msg"></div>
<div id="resultado" style="display:none">
<p>Instale o link abaixo no Stremio:</p>
<input type="text" id="link" readonly onclick="this.select()">
<button onclick="copiar()">Copiar link</button>
<button class="sec" onclick="instalar()">Instalar no Stremio (app)</button>
<button class="sec" onclick="instalarWeb()">Instalar no Stremio Web</button>
</div></div>
<script>
var SELF_ID=${JSON.stringify(SELF_ID)};
var caminho='', AUTH='';
function msg(t){document.getElementById('msg').textContent=t}
function b64u(s){return btoa(unescape(encodeURIComponent(s))).split('+').join('-').split('/').join('_').split('=').join('')}
function copiar(){var c=document.getElementById('link');c.select();document.execCommand('copy');msg('Link copiado!')}
function instalar(){window.location.href='stremio://'+caminho}
function instalarWeb(){window.open('https://web.stremio.com/#/addons?addon='+encodeURIComponent(location.protocol+'//'+caminho),'_blank')}
async function api(rota,corpo){
  var r=await fetch('https://api.strem.io/api/'+rota,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)});
  return r.json();
}
async function entrar(){
  msg('A entrar...');
  try{
    var j=await api('login',{type:'Login',email:document.getElementById('email').value.trim(),password:document.getElementById('senha').value,facebook:false});
    if(!j.result||!j.result.authKey){msg('Login falhou: confira os dados.');return}
    AUTH=j.result.authKey;
    var c=await api('addonCollectionGet',{type:'AddonCollectionGet',authKey:AUTH,update:true});
    if(!c.result||!c.result.addons){msg('Não foi possível ler os addons.');return}
    var sel=[];
    c.result.addons.forEach(function(a){
      var m=a.manifest||{};
      if(!/^https?:/i.test(a.transportUrl||''))return;
      var rs=m.resources||[];
      var hasStream=false;
      for(var i=0;i<rs.length;i++){
        if(rs[i]==='stream'||(rs[i]&&rs[i].name==='stream'))hasStream=true;
      }
      if(!hasStream)return;
      sel.push({n:m.name||a.transportUrl,u:a.transportUrl.replace(/\\/manifest\\.json$/i,''),t:m.types||[],p:m.idPrefixes||[]});
    });
    var cfg={a:sel,k:AUTH};
    caminho=location.host+'/'+b64u(JSON.stringify(cfg))+'/manifest.json';
    document.getElementById('link').value=location.protocol+'//'+caminho;
    document.getElementById('passo1').style.display='none';
    document.getElementById('resultado').style.display='block';
    msg('Pronto: '+sel.length+' addon(s) carregados.');
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
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift();
      if (['manifest.json', 'meta', 'stream'].includes(partes[0])) gravarMeuLink(ctx, url, cfgB64);
      if (partes[0] === 'health') return json({ ok: true });
      if (partes[0] === 'configure') return paginaConfig();
      if (partes[0] === 'manifest.json') return json(manifest(base));

      if (partes[0] === 'check_tempo.png') {
        return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'image/png' } });
      }

      if (partes[0] === 'ultimos') {
        let lista = recentes;
        if (KV) { try { const l = JSON.parse((await KV.get('ultimos')) || '[]'); if (l.length) lista = l; } catch {} }
        return texto(200, lista.length ? lista.join('\n\n') : 'Sem registos recentes.');
      }

      if (partes[0] === 'diagnostico') {
        const o = await listaDeOrigens(cfgB64, url.hostname, null, null);
        return json({
          status: 'ok',
          addons_com_stream: o.lista.map((a) => a.n),
          fora_da_lista: o.ignorados,
        });
      }

      if (partes[0] === 'meta') {
        const tipo = decodeURIComponent(partes[1] || '');
        const idPed = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        const idTT = idPed.replace(/^vrf:/, '');
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(idTT)) return json({ err: 'id não suportado' }, 404);
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ua = request.headers.get('User-Agent') || UA;
        const cab = { 'User-Agent': ua, Accept: 'application/json', 'X-Via': 'autenticado' };
        if (ip) { cab['X-Forwarded-For'] = ip; cab['X-Real-IP'] = ip; }
        const chaveC = `${cfgB64.slice(-16)}|${MODO_FILME}|${tipo}|${idTT}`;
        const emC = cacheMeta.get(chaveC);
        if (emC && Date.now() - emC.t < 5 * 60 * 1000) return json({ meta: emC.meta });
        
        const f = await fontesDeMeta(cfgB64, url.hostname, tipo, idTT);
        const cabPonte = Object.assign({}, cab, ip ? { 'CF-Connecting-IP': ip } : {});
        const tent = f.lista.map((a) => { const ponte = RE_PARENTAL.test(a.n) ? CONTROLE_BIND : null; return metaDe(a.u, tipo, idTT, ponte ? cabPonte : cab, ponte); });
        let achado = null;
        for (let k = 0; k < tent.length; k++) {
          const r = await tent[k];
          if (r.meta) {
            achado = r.meta;
            if (RE_PARENTAL.test(f.lista[k].n) && k + 1 < tent.length) {
              const resto = await Promise.race([Promise.all(tent.slice(k + 1)), new Promise((res) => setTimeout(() => res(null), 1500))]);
              const o = resto && resto.findIndex((x) => x && x.meta);
              if (resto && o >= 0) {
                const c = completarMeta(achado, resto[o].meta);
                achado = c.meta;
              }
            }
            break;
          }
        }
        if (!achado) return json({ err: 'sem fonte de meta' }, 404);
        const tr = trocarIds(achado, tipo);
        if (cacheMeta.size >= 500) cacheMeta.clear();
        cacheMeta.set(chaveC, { t: Date.now(), meta: tr.meta });
        return json({ meta: tr.meta });
      }

      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(partes[1] || '');
        const idPed = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        const id = idPed.replace(/^vrf:/, '');
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return json({ streams: [] });

        const chaveCacheStreams = `${tipo}|${id}`;
        const listaCache = await cLerStream(chaveCacheStreams);
        if (listaCache) return json({ streams: listaCache });

        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
        const falhas = [];
        const estat = new Map();
        if (ATRASO_STREAM_MS > 0 && origens.lista.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, ATRASO_STREAM_MS));
        }
        const listas = await Promise.all(origens.lista.map((a) => streamsDe(a.u, tipo, id, a.n, falhas, estat)));
        const itens = [];
        origens.lista.forEach((a, k) => listas[k].forEach((s) => itens.push({ s, origem: a.n })));

        // Passa todos os streams diretamente, sem filtros ou bloqueios de duração
        const streams = await Promise.all(itens.map(async (it) => {
          let s = await reescrever(it.s, base, tipo, id);
          const nomeOriginal = s.name || s.title || 'Stream';
          s = Object.assign({}, s, { name: rotuloOrigem(nomeOriginal, it.origem) });
          return s;
        }));

        if (streams && streams.length > 0) {
          await cGravarStream(chaveCacheStreams, streams);
        }

        const painel = [`${tipo} ${idPed}`, `  = na lista final: ${streams.length} streams`];
        guardar(ctx, painel.join('\n'));
        return json({ streams });
      }

      if (partes[0] === 'play') {
        const dados = await lerToken(partes[1]);
        if (!dados || !/^https?:\/\//i.test(dados.u || '')) return texto(403, 'Link inválido');
        return new Response(null, { status: 302, headers: { Location: dados.u, 'Cache-Control': 'no-store' } });
      }

      return json({ erro: 'não encontrado' }, 404);
    } catch (e) {
      return json({ streams: [] }, 500);
    }
  },
};