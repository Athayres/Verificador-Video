/**
 * Addon Stremio para Cloudflare Workers
 * - Lê os addons de stream instalados na sua conta do Stremio automaticamente.
 * - Busca os streams de todos eles em paralelo.
 * - Filtra e remove completamente os streams incorretos/inválidos antes de enviar ao Stremio.
 */
const SELF_ID = 'community.verificador.duracao';
const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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

function lerConfigConta(b64) {
  if (!b64) return null;
  try {
    const j = JSON.parse(td.decode(b64uParaBytes(b64)));
    return j && typeof j.k === 'string' && j.k ? j : null;
  } catch { return null; }
}

const limparUrl = (u) => String(u || '').trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
const hostDe = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Verifica se o manifesto tem o recurso "stream"
function recursoStream(m) {
  for (const r of (m.resources || [])) {
    if (typeof r === 'string') { if (r === 'stream') return { types: m.types || [], prefixes: m.idPrefixes || [] }; }
    else if (r && r.name === 'stream') return { types: r.types || m.types || [], prefixes: r.idPrefixes || m.idPrefixes || [] };
  }
  return null;
}

// Busca os addons instalados na conta do Stremio
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
  if (!j.result || !Array.isArray(j.result.addons)) throw new Error('Sessão do Stremio inválida ou expirada');
  
  const lista = [];
  for (const a of j.result.addons) {
    if (!a || !a.manifest || a.manifest.id === SELF_ID || !/^https?:/i.test(a.transportUrl || '')) continue;
    const rec = recursoStream(a.manifest);
    if (!rec) continue; // Apenas addons que possuem stream
    lista.push({ n: a.manifest.name || hostDe(a.transportUrl), u: limparUrl(a.transportUrl), types: rec.types, prefixes: rec.prefixes });
  }
  
  if (cacheContas.size >= 200) cacheContas.clear();
  cacheContas.set(authKey, { t: Date.now(), lista });
  return lista;
}

async function listaDeOrigens(cfgB64, host, tipo, id) {
  let lista = [];
  const cfg = lerConfigConta(cfgB64);
  if (cfg) {
    try { lista = await addonsDaConta(cfg.k); } catch (e) { console.error('[conta Stremio]', e.message); }
  }
  lista = lista
    .filter((a) => !a.types.length || !tipo || a.types.includes(tipo))
    .filter((a) => !a.prefixes.length || !id || a.prefixes.some((p) => id.startsWith(p)));
  
  const vistos = new Set();
  return lista
    .filter((a) => hostDe(a.u) !== host)
    .filter((a) => !vistos.has(a.u) && vistos.add(a.u))
    .slice(0, 30);
}

async function streamsDe(base, tipo, id) {
  try {
    const r = await fetch(`${base}/stream/${tipo}/${encodeURIComponent(id)}.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.streams) ? j.streams : [];
  } catch {
    return [];
  }
}

// Lógica de validação individual de cada stream
async function verificarStreamValido(stream, id) {
  try {
    // Insira aqui a sua lógica de checagem (duração, tamanho, etc.)
    // Se retornar `false`, o stream é apagado completamente da lista.
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function manifest(base) {
  return {
    id: SELF_ID,
    version: '2.0.0',
    name: 'Verificador & Filtro de Streams',
    description: 'Lê os addons de stream da sua conta Stremio e remove automaticamente conteúdos incorretos.',
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
    },
  });
}

function paginaConfig() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuração - Filtro Stremio</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#121212;color:#fff;padding:20px;display:flex;justify-content:center;align-items:center;min-height:90vh;margin:0}
.box{max-width:440px;width:100%;background:#1e1e1e;padding:25px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.6)}
input{width:100%;padding:12px;margin:8px 0;background:#2a2a2a;border:1px solid #444;color:#fff;border-radius:6px;box-sizing:border-box;font:inherit}
button{background:#e50914;color:#fff;border:0;padding:12px;width:100%;border-radius:6px;font-weight:700;font-size:15px;cursor:pointer;margin-top:8px}
button.sec{background:#2d2d2d;border:1px solid #444}
button.sec:hover{background:#3d3d3d}
button.copy{background:#2563eb}
p{color:#aaa;font-size:13px;line-height:1.4}
#msg{color:#ffb74d;font-size:13px;min-height:18px;margin-top:6px}
.btn-group{display:flex;flex-direction:column;gap:8px;margin-top:10px}
</style></head><body><div class="box">
<h2 style="text-align:center;color:#e50914;margin-top:0">Configurar Addon</h2>
<p>Entre com a sua conta do Stremio. O addon vai ler automaticamente os seus addons de stream instalados ("do meta") e aplicar o filtro.</p>
<input type="email" id="email" placeholder="E-mail do Stremio" autocomplete="username">
<input type="password" id="senha" placeholder="Senha" autocomplete="current-password">
<button onclick="entrar()">Entrar e Gerar Link</button>
<div id="msg"></div>
<div id="resultado" style="display:none;margin-top:20px">
<p style="color:#4ade80"><b>Pronto!</b> Escolha uma das opções abaixo para instalar:</p>
<input type="text" id="link" readonly onclick="this.select()" style="font-size:11px;color:#888">
<div class="btn-group">
<button onclick="instalarApp()">Instalar no App (Stremio)</button>
<button class="sec" onclick="instalarWeb()">Instalar na Versão Web</button>
<button class="copy" onclick="copiar()">Copiar Link do Manifesto</button>
</div>
</div></div>
<script>
var caminho='';
function msg(t){document.getElementById('msg').textContent=t}
function b64u(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')}
function copiar(){var c=document.getElementById('link');c.select();document.execCommand('copy');msg('Link copiado para a área de transferência!');}
function instalarApp(){window.location.href='stremio://'+caminho}
function instalarWeb(){window.open('https://web.stremio.com/#/addons?addon='+encodeURIComponent(location.protocol+'//'+caminho),'_blank')}
async function entrar(){
  msg('Autenticando...');
  try{
    var r=await fetch('https://api.strem.io/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'Login',email:document.getElementById('email').value.trim(),password:document.getElementById('senha').value,facebook:false})});
    var j=await r.json();
    if(!j.result||!j.result.authKey){msg('Login falhou: confira e-mail e senha.');return}
    caminho=location.host+'/'+b64u(JSON.stringify({k:j.result.authKey}))+'/manifest.json';
    document.getElementById('link').value=location.protocol+'//'+caminho;
    document.getElementById('resultado').style.display='block';
    msg('');
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
      
      const url = new URL(request.url);
      const partes = url.pathname.split('/').filter(Boolean);
      const base = url.origin;
      
      if (!partes.length) return Response.redirect(`${url.origin}/configure`, 302);
      
      const RESERVADOS = ['configure', 'manifest.json', 'stream'];
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift();
      
      if (partes[0] === 'configure') return paginaConfig();
      if (partes[0] === 'manifest.json') return json(manifest(base));

      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(partes[1] || '');
        const id = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) {
          return json({ streams: [] });
        }

        // 1. Pega os addons de stream instalados na conta do Stremio ("do meta")
        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
        
        // 2. Busca os streams de todos os addons de origem em paralelo
        const listas = await Promise.all(origens.map((a) => streamsDe(a.u, tipo, id)));
        const itensBrutos = [];
        origens.forEach((a, k) => listas[k].forEach((s) => itensBrutos.push(s)));

        // 3. Valida cada stream e FILTRA (remove completamente os inválidos)
        const promessasValidacao = itensBrutos.map(async (stream) => {
          const valido = await verificarStreamValido(stream, id);
          return { stream, valido };
        });

        const resultados = await Promise.all(promessasValidacao);
        const streamsValidos = resultados.filter((r) => r.valido).map((r) => r.stream);

        return json({ streams: streamsValidos });
      }

      return json({ erro: 'não encontrado' }, 404);
    } catch (e) {
      return json({ streams: [] }, 500);
    }
  },
};