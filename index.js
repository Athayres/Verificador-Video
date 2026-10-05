const SELF_ID = 'org.verificador.stream';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const STREMIO_API = 'https://api.strem.io/api';
const CACHE_MS = 5 * 60 * 1000;
const STREAM_TIMEOUT = 8000;
const STREAM_CACHE_MS = 2 * 60 * 1000;
const META_CACHE_MS = 24 * 60 * 60 * 1000;

const cacheAddons = new Map();
const cacheMeta = new Map();
const cacheStreams = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Accept': 'application/json'
};

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json; charset=utf-8'
};

const manifest = {
    id: SELF_ID,
    version: '6.2.0',
    name: 'Verificador de Streams ⚠️',
    description: 'Junta os streams dos seus outros addons e avisa quando o conteúdo parece incorreto.',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true }
};

// ---------- Utilitários ----------
const limparUrl = (u) => String(u || '').trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');

async function fetchJson(url, ms = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, { signal: controller.signal, headers: HEADERS });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

async function postJson(url, corpo, ms = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify(corpo)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

const normalizar = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

function nomeDoHost(u) {
    try { return new URL(u).hostname; } catch (e) { return 'addon'; }
}

function temStream(m) {
    return (m.resources || []).some(r => (typeof r === 'string' ? r : r && r.name) === 'stream');
}

function parseConfig(configStr) {
    if (!configStr) return null;
    try {
        let b64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const jsonStr = decodeURIComponent(escape(atob(b64)));
        return JSON.parse(jsonStr);
    } catch (e) {
        return null;
    }
}

async function addonsDaConta(authKey) {
    const hit = cacheAddons.get(authKey);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.lista;

    const j = await postJson(`${STREMIO_API}/addonCollectionGet`, { type: 'AddonCollectionGet', authKey, update: true });
    if (!j.result || !Array.isArray(j.result.addons)) {
        throw new Error('sessão do Stremio inválida ou expirada');
    }
    const lista = j.result.addons
        .filter(a => a && a.manifest && a.manifest.id !== SELF_ID && temStream(a.manifest) && /^https?:/i.test(a.transportUrl || ''))
        .map(a => ({ n: a.manifest.name, u: a.transportUrl, types: a.manifest.types || [], prefixes: a.manifest.idPrefixes || null }));

    cacheAddons.set(authKey, { t: Date.now(), lista });
    return lista;
}

async function listaDeAddons(config, host, type, id) {
    let lista = [];
    const cfg = parseConfig(config);

    if (cfg && cfg.k) {
        try {
            lista = await addonsDaConta(cfg.k);
        } catch (e) {
            console.error('[CONTA STREMIO ERRO]:', e.message);
        }
    }

    const vistos = new Set();
    return lista
        .map(a => ({ ...a, n: a.n || nomeDoHost(a.u), u: limparUrl(a.u) }))
        .filter(a => /^https?:\/\//i.test(a.u))
        .filter(a => nomeDoHost(a.u) !== String(host || '').split(':')[0])
        .filter(a => !a.types || a.types.length === 0 || a.types.includes(type))
        .filter(a => !a.prefixes || a.prefixes.length === 0 || a.prefixes.some(p => id.startsWith(p)))
        .filter(a => !vistos.has(a.u) && vistos.add(a.u));
}

async function fetchCinemeta(type, id) {
    const baseId = id.split(':')[0];
    const chave = `${type}/${baseId}`;
    const hit = cacheMeta.get(chave);
    if (hit && Date.now() - hit.t < META_CACHE_MS) return hit.meta;
    try {
        const data = await fetchJson(`${CINEMETA}/meta/${type}/${baseId}.json`);
        const meta = data.meta || null;
        if (meta) cacheMeta.set(chave, { t: Date.now(), meta });
        return meta;
    } catch (err) {
        return null;
    }
}

async function streamsDoAddon(a, type, id) {
    const chave = `${a.u}|${type}|${id}`;
    const hit = cacheStreams.get(chave);
    if (hit && Date.now() - hit.t < STREAM_CACHE_MS) return hit.lista;
    const data = await fetchJson(`${a.u}/stream/${type}/${id}.json`, STREAM_TIMEOUT);
    const lista = Array.isArray(data.streams) ? data.streams : [];
    cacheStreams.set(chave, { t: Date.now(), lista });
    if (cacheStreams.size > 500) cacheStreams.delete(cacheStreams.keys().next().value);
    return lista;
}

function palavrasDoTitulo(titulo) {
    return normalizar(titulo).split(' ').filter(p => p.length > 3);
}

function streamIncorreto(stream, palavras) {
    if (!palavras || palavras.length === 0) return false;
    const texto = normalizar([
        stream.title,
        stream.description,
        stream.name,
        stream.filename,
        stream.behaviorHints && stream.behaviorHints.filename
    ].filter(Boolean).join(' '));
    return !palavras.some(p => texto.includes(p));
}

function marcar(stream, addonNome, incorreto) {
    const r = { ...stream, name: `${incorreto ? '⚠️ ' : ''}[${addonNome}] ${stream.name || 'Stream'}` };
    if (incorreto) {
        const detalhe = stream.title || stream.description || stream.filename || 'Sem detalhes';
        if (stream.description !== undefined) r.description = `⚠️ [CONTEÚDO INCORRETO] ${stream.description}`;
        if (stream.title !== undefined || stream.description === undefined) r.title = `⚠️ [CONTEÚDO INCORRETO] ${stream.title || detalhe}`;
    }
    return r;
}

// ---------- Página HTML de Configuração ----------
function renderConfigurePage(host, protocol) {
    const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configurar Verificador</title>
<style>
body { font-family: Arial, sans-serif; background: #111; color: #fff; padding: 20px; }
.box { max-width: 460px; margin: auto; background: #222; padding: 20px; border-radius: 8px; }
input { width: 100%; padding: 10px; margin: 6px 0; background: #333; border: 1px solid #444; color: #fff; border-radius: 4px; box-sizing: border-box; }
button { background: #e50914; color: #fff; border: 0; padding: 12px; width: 100%; border-radius: 4px; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 8px; }
p { color: #aaa; font-size: 13px; }
#msg { color: #ffb74d; font-size: 14px; min-height: 18px; }
</style>
</head>
<body>
<div class="box">
  <h2 style="text-align:center">Verificador de Streams</h2>
  <p>Entre com a sua conta do Stremio. O Verificador passa a usar automaticamente todos os addons com streams que você tiver instalados.</p>
  <input type="email" id="email" placeholder="E-mail do Stremio">
  <input type="password" id="senha" placeholder="Senha">
  <button onclick="entrar()">Entrar e gerar link</button>
  <div id="msg"></div>
  <div id="resultado" style="display:none">
    <p>Link do addon (cole em Stremio &gt; Addons &gt; campo de busca/URL):</p>
    <input type="text" id="link" readonly onclick="this.select()">
    <button onclick="copiar()">Copiar link</button>
    <button onclick="instalar()" style="background:#444">Instalar no Stremio</button>
  </div>
</div>
<script>
var caminho = '';
function msg(t) { document.getElementById('msg').textContent = t; }
function copiar() {
  var campo = document.getElementById('link');
  campo.select();
  document.execCommand('copy');
  msg('Link copiado!');
}
function instalar() { window.location.href = 'stremio://' + caminho; }
function b64u(s) {
  return btoa(unescape(encodeURIComponent(s))).split('+').join('-').split('/').join('_').split('=').join('');
}
async function entrar() {
  msg('A entrar...');
  try {
    var r = await fetch('https://api.strem.io/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Login', email: document.getElementById('email').value.trim(), password: document.getElementById('senha').value, facebook: false })
    });
    var j = await r.json();
    if (!j.result || !j.result.authKey) { msg('Login falhou: confira e-mail e senha.'); return; }
    caminho = '${host}/' + b64u(JSON.stringify({ k: j.result.authKey })) + '/manifest.json';
    document.getElementById('link').value = '${protocol}://' + caminho;
    document.getElementById('resultado').style.display = 'block';
    msg('Pronto. Copie o link ou instale direto.');
  } catch (e) {
    msg('Erro: ' + e.message);
  }
}
</script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- Main Fetch Handler para Cloudflare Workers ----------
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const host = url.host;
        const protocol = url.protocol.replace(':', '');

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // 1. Redirecionamentos e Página de Configuração
        if (path === '/') {
            return Response.redirect(`${url.origin}/configure`, 302);
        }
        if (path === '/configure') {
            return renderConfigurePage(host, protocol);
        }

        // 2. Manifesto (com ou sem config)
        if (path === '/manifest.json' || /^\/[^\/]+\/manifest\.json$/.test(path)) {
            const manifestComLogo = {
                ...manifest,
                logo: `${protocol}://${host}/check_tempo.jpg`
            };
            return new Response(JSON.stringify(manifestComLogo), { headers: corsHeaders });
        }

        // 3. Logótipo (placeholder / ícone do relógio)
        if (path === '/check_tempo.jpg') {
            // Retorna um ícone SVG leve convertido em resposta de imagem
            const svgLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100" height="100"><circle cx="256" cy="256" r="240" fill="#00bcd4"/><path d="M160 260l70 70 130-130" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round"/></svg>`;
            return new Response(svgLogo, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
        }

        // 4. Streams
        const streamRegex = /^(?:\/([^\/]+))?\/stream\/(movie|series)\/(tt\d+(?::\d+:\d+)?)\.json$/;
        const match = path.match(streamRegex);

        if (match) {
            const config = match[1];
            const type = match[2];
            const id = match[3];

            const metaP = fetchCinemeta(type, id);
            const addons = await listaDeAddons(config, host, type, id);

            if (addons.length === 0) {
                return new Response(JSON.stringify({ streams: [] }), { headers: corsHeaders });
            }

            const addonsP = addons.map(a => streamsDoAddon(a, type, id));
            const [meta, resultados] = await Promise.all([metaP, Promise.allSettled(addonsP)]);

            const tituloOficial = meta && meta.name ? meta.name : '';
            const palavras = palavrasDoTitulo(tituloOficial);

            const streams = [];
            resultados.forEach((r, i) => {
                const a = addons[i];
                if (r.status !== 'fulfilled') return;
                r.value.forEach(s => {
                    const incorreto = streamIncorreto(s, palavras);
                    streams.push(marcar(s, a.n, incorreto));
                });
            });

            return new Response(JSON.stringify({ streams, cacheMaxAge: 120 }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
    }
};