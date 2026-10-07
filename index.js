// ==========================================
// PREENCHA AQUI COM OS DADOS ORIGINAIS DO SEU ADDON
// ==========================================
const CONFIG_ADDON = {
  id: 'org.stremio.seuaddonoriginal',           // Coloque o ID original do seu addon
  version: '1.0.0',
  name: 'Nome Original do Seu Addon',           // Coloque o nome original aqui
  description: 'Sua descrição original aqui',   // Coloque a descrição original aqui
  logo: 'https://exemplo.com/seu-logo.png',     // Cole a URL do seu logo original aqui
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

// Filtro robusto que remove completamente os streams inválidos
async function filtrarStreamsInvalidos(streams, id) {
  if (!Array.isArray(streams) || streams.length === 0) return [];
  const checks = streams.map(async (stream) => {
    const valid = await verificarDuracaoOuConteudo(stream, id);
    return { stream, valid };
  });
  const results = await Promise.all(checks);
  return results.filter(r => r.valid).map(r => r.stream);
}

async function verificarDuracaoOuConteudo(stream, imdbId) {
  try {
    // Insira aqui sua regra de validação. Retorne `false` para remover o stream da lista.
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

function getHtmlConfigPage(host) {
  const workerBaseUrl = `https://${host}`;

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG_ADDON.name} - Configuração</title>
    <style>
      body {
        background-color: #121212;
        color: #ffffff;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
      }
      .card {
        background: #1e1e1e;
        padding: 30px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        max-width: 440px;
        width: 100%;
        text-align: center;
      }
      h1 {
        color: #e50914;
        margin-bottom: 10px;
        font-size: 22px;
      }
      p {
        color: #b3b3b3;
        font-size: 14px;
        margin-bottom: 20px;
        line-height: 1.4;
      }
      input {
        width: 100%;
        padding: 12px;
        margin: 8px 0;
        background: #2a2a2a;
        border: 1px solid #444;
        color: #fff;
        border-radius: 6px;
        box-sizing: border-box;
        font: inherit;
      }
      .btn {
        display: block;
        width: 100%;
        padding: 12px;
        margin-top: 10px;
        border-radius: 6px;
        font-weight: bold;
        font-size: 14px;
        text-decoration: none;
        border: none;
        cursor: pointer;
        box-sizing: border-box;
        transition: background 0.2s;
      }
      .btn-app { background-color: #e50914; color: #fff; }
      .btn-app:hover { background-color: #b20710; }
      
      .btn-web { background-color: #2d2d2d; color: #fff; border: 1px solid #444; }
      .btn-web:hover { background-color: #3d3d3d; }
      
      .btn-copy { background-color: #2563eb; color: #fff; }
      .btn-copy:hover { background-color: #1d4ed8; }

      .link-box {
        background: #121212;
        padding: 10px;
        border-radius: 6px;
        font-size: 11px;
        color: #888;
        word-break: break-all;
        margin-top: 15px;
        border: 1px solid #333;
        text-align: left;
      }
      #toast {
        margin-top: 10px;
        font-size: 12px;
        color: #4ade80;
        display: none;
      }
      #msg { color: #ffb74d; font-size: 13px; min-height: 18px; margin-top: 6px; }
      .btn-group { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${CONFIG_ADDON.name}</h1>
      <p>${CONFIG_ADDON.description}</p>
      <p style="font-size:12px; color:#aaa;">Entre com sua conta do Stremio para autenticar e carregar seus addons de stream instalados automaticamente.</p>
      
      <input type="email" id="email" placeholder="E-mail do Stremio" autocomplete="username">
      <input type="password" id="senha" placeholder="Senha" autocomplete="current-password">
      <button onclick="entrar()" class="btn btn-app">Entrar e Gerar Link</button>
      <div id="msg"></div>

      <div id="resultado" style="display:none; margin-top:15px;">
        <div class="link-box" id="manifestLink"></div>
        <div class="btn-group">
          <button onclick="instalarApp()" class="btn btn-app">Instalar no App (Desktop/Mobile)</button>
          <button onclick="instalarWeb()" class="btn btn-web">Instalar na Versão Web</button>
          <button onclick="copiarLink()" class="btn btn-copy">Copiar Link do Manifesto</button>
        </div>
        <div id="toast">Link copiado com sucesso!</div>
      </div>
    </div>

    <script>
      const workerUrl = "${workerBaseUrl}";
      var caminho = '';

      function msg(t) { document.getElementById('msg').textContent = t; }
      function b64u(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }

      async function entrar() {
        msg('Autenticando...');
        try {
          const r = await fetch('https://api.strem.io/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'Login', email: document.getElementById('email').value.trim(), password: document.getElementById('senha').value, facebook: false })
          });
          const j = await r.json();
          if (!j.result || !j.result.authKey) { msg('Login falhou: verifique e-mail e senha.'); return; }
          
          caminho = workerUrl + '/' + b64u(JSON.stringify({ k: j.result.authKey })) + '/manifest.json';
          document.getElementById('manifestLink').innerText = caminho;
          document.getElementById('resultado').style.display = 'block';
          msg('');
        } catch(e) { msg('Erro: ' + e.message); }
      }

      function instalarApp() {
        window.location.href = 'stremio://' + caminho.replace('https://', '');
      }

      function instalarWeb() {
        window.open('https://web.stremio.com/#/addons?addon=' + encodeURIComponent(caminho), '_blank');
      }

      function copiarLink() {
        navigator.clipboard.writeText(caminho).then(() => {
          const toast = document.getElementById('toast');
          toast.style.display = 'block';
          setTimeout(() => { toast.style.display = 'none'; }, 3000);
        });
      }
    </script>
  </body>
  </html>`;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Tratar requisições OPTIONS (CORS)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': '*'
          }
        });
      }

      const partes = url.pathname.split('/').filter(Boolean);
      const base = url.origin;

      if (!partes.length) return Response.redirect(`${url.origin}/configure`, 302);

      const RESERVADOS = ['configure', 'manifest.json', 'stream'];
      const cfgB64 = RESERVADOS.includes(partes[0]) ? '' : partes.shift();

      // 1. Rota da Tela de Configuração
      if (partes[0] === 'configure' || url.pathname === '/' || url.pathname === '') {
        return new Response(getHtmlConfigPage(url.hostname), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      // 2. Rota do Manifesto do Stremio (Usa o CONFIG_ADDON original)
      if (partes[0] === 'manifest.json') {
        const manifest = {
          id: CONFIG_ADDON.id,
          version: CONFIG_ADDON.version,
          name: CONFIG_ADDON.name,
          description: CONFIG_ADDON.description,
          logo: CONFIG_ADDON.logo,
          types: CONFIG_ADDON.types,
          catalogs: CONFIG_ADDON.catalogs,
          resources: CONFIG_ADDON.resources,
          idPrefixes: CONFIG_ADDON.idPrefixes,
          behaviorHints: { configurable: true }
        };
        return json(manifest);
      }

      // 3. Rota de Streams (Lê addons da conta via meta, busca em paralelo e filtra)
      if (partes[0] === 'stream') {
        const tipo = decodeURIComponent(pathParts[1] || partes[1] || '');
        const id = decodeURIComponent((partes[2] || '').replace(/\.json$/, ''));

        if (!['movie', 'series'].includes(tipo) || !/^tt\d+(:\d+:\d+)?$/.test(id)) {
          return json({ streams: [] });
        }

        // Pega os addons de stream instalados na conta do Stremio automaticamente
        const origens = await listaDeOrigens(cfgB64, url.hostname, tipo, id);

        // Busca streams de todos os provedores em paralelo
        const listas = await Promise.all(origens.map((a) => streamsDe(a.u, tipo, id)));
        const itensBrutos = [];
        origens.forEach((a, k) => listas[k].forEach((s) => itensBrutos.push(s)));

        // Aplica o filtro robusto (.filter) para remover completamente os streams inválidos
        const streamsValidos = await filtrarStreamsInvalidos(itensBrutos, id);

        return json({ streams: streamsValidos });
      }

      return new Response('Página não encontrada', { status: 404 });
    } catch (error) {
      return json({ streams: [] }, 500);
    }
  }
};