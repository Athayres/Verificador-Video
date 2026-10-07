// ==========================================
// CONFIGURAÇÃO DO SEU ADDON
// ==========================================
const CONFIG_ADDON = {
  id: 'org.stremio.seuaddonoriginal',           // Substitua pelo seu ID original
  version: '1.0.0',
  name: 'Nome Original do Seu Addon',           // Substitua pelo seu nome original
  description: 'Sua descrição original aqui',   // Substitua pela sua descrição original
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt']
};

const STREMIO_API = 'https://api.strem.io/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const td = new TextDecoder();

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
  if (!j.result || !Array.isArray(j.result.addons)) throw new Error('Sessão inválida');
  
  const lista = [];
  for (const a of j.result.addons) {
    if (!a || !a.manifest || a.manifest.id === CONFIG_ADDON.id || !/^https?:/i.test(a.transportUrl || '')) continue;
    const rec = recursoStream(a.manifest);
    if (!rec) continue;
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
    try { lista = await addonsDaConta(cfg.k); } catch (e) {}
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

// Lógica de validação e remoção de streams incorretos
async function verificarStreamValido(stream, id) {
  try {
    // Insira sua regra de validação aqui. Retorne `false` para apagar o stream da lista.
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
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

// Gera o logo diretamente no Worker
function gerarLogoSvg() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" rx="110" fill="#121212"/>
    <circle cx="256" cy="256" r="170" fill="none" stroke="#e50914" stroke-width="28"/>
    <polygon points="205,165 345,256 205,347" fill="#ffffff"/>
  </svg>`;
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

function paginaConfig() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${CONFIG_ADDON.name} - Configuração</title>
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
<h2 style="text-align:center;color:#e50914;margin-top:0">${CONFIG_ADDON.name}</h2>
<p>Entre com a sua conta do Stremio para ler automaticamente os seus addons instalados e aplicar os filtros.</p>
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
      
      // Rota para servir o logo gerado pelo próprio Worker
      if (url.pathname === '/logo' || url.pathname === '/logo.png') {
        return gerarLogoSvg();
      }
      
      const RESERVADOS = ['configure', 'manifest.json', 'stream', 'logo'];
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift();
      
      if (partes[0] === 'configure') return paginaConfig();
      if (partes[0] === 'manifest.json') {
        return json({
          id: CONFIG_ADDON.id,
          version: CONFIG_ADDON.version,
          name: CONFIG_ADDON.name,
          description: CONFIG_ADDON.description,
          logo: `${base}/logo`,
          resources: CONFIG_ADDON.resources,
          types: CONFIG_ADDON.types,
          idPrefixes: CONFIG_ADDON.idPrefixes,
          catalogs: CONFIG_ADDON.catalogs,
          behaviorHints: { configurable: true }
        });
      }

      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(partes[1] || '');
        const id = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));
        
        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) {
          return json({ streams: [] });
        }

        // Lê os addons de stream instalados na conta do Stremio automaticamente
        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);
        
        // Busca os streams em paralelo
        const listas = await Promise.all(origens.map((a) => streamsDe(a.u, tipo, id)));
        const itensBrutos = [];
        origens.forEach((a, k) => listas[k].forEach((s) => itensBrutos.push(s)));

        // Aplica o filtro e remove completamente os streams inválidos
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