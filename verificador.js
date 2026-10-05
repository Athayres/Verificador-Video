const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const SELF_ID = 'org.verificador.stream';
const CINEMETA = (process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io').replace(/\/+$/, '');
const STREMIO_API = (process.env.STREMIO_API || 'https://api.strem.io/api').replace(/\/+$/, '');
const CACHE_MS = 5 * 60 * 1000;
const LOGO_FILE = path.join(__dirname, 'check_tempo.jpg');
const STREAM_TIMEOUT = 10000;      // tempo máximo por addon
const STREAM_CACHE_MS = 2 * 60 * 1000;
const META_CACHE_MS = 24 * 60 * 60 * 1000;

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Accept': 'application/json'
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

function temStream(m) {
    return (m.resources || []).some(r => (typeof r === 'string' ? r : r && r.name) === 'stream');
}

// Busca os addons instalados na conta do Stremio (com cache de 5 min)
const cacheAddons = new Map();
async function addonsDaConta(authKey) {
    const hit = cacheAddons.get(authKey);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.lista;

    const j = await postJson(`${STREMIO_API}/addonCollectionGet`, { type: 'AddonCollectionGet', authKey, update: true });
    if (!j.result || !Array.isArray(j.result.addons)) {
        throw new Error('sessão do Stremio inválida ou expirada (reinstale pelo /configure)');
    }
    const lista = j.result.addons
        .filter(a => a && a.manifest && a.manifest.id !== SELF_ID && temStream(a.manifest) && /^https?:/i.test(a.transportUrl || ''))
        .map(a => ({ n: a.manifest.name, u: a.transportUrl, types: a.manifest.types || [], prefixes: a.manifest.idPrefixes || null }));

    cacheAddons.set(authKey, { t: Date.now(), lista });
    return lista;
}

// Lista final de addons a consultar: conta Stremio (automático) ou variável ADDONS como reserva
async function listaDeAddons(config, host, type, id) {
    let lista = [];

    let cfg = null;
    if (config) {
        try { cfg = JSON.parse(Buffer.from(config, 'base64url').toString('utf8')); } catch (e) { /* inválida */ }
    }

    if (cfg && cfg.k) {
        try {
            lista = await addonsDaConta(cfg.k);
        } catch (e) {
            console.error('[CONTA STREMIO ERRO]:', e.message);
        }
    }

    if (lista.length === 0 && process.env.ADDONS) {
        lista = process.env.ADDONS.split(/[\n,]+/).map(s => ({ u: s }));
    }

    const vistos = new Set();
    return lista
        .map(a => ({ ...a, n: a.n || nomeDoHost(a.u), u: limparUrl(a.u) }))
        .filter(a => /^https?:\/\//i.test(a.u))
        .filter(a => nomeDoHost(a.u) !== String(host || '').split(':')[0]) // nunca chama a si próprio
        .filter(a => !a.types || a.types.length === 0 || a.types.includes(type))
        .filter(a => !a.prefixes || a.prefixes.length === 0 || a.prefixes.some(p => id.startsWith(p)))
        .filter(a => !vistos.has(a.u) && vistos.add(a.u));
}

// ---------- Manifesto ----------
app.get('/', (req, res) => res.redirect('/configure'));
function manifestComLogo(req) {
    if (!fs.existsSync(LOGO_FILE)) return manifest;
    return { ...manifest, logo: `${req.protocol}://${req.get('host')}/check_tempo.jpg` };
}
app.get('/check_tempo.jpg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(LOGO_FILE, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
app.get('/manifest.json', (req, res) => res.json(manifestComLogo(req)));
app.get('/:config/manifest.json', (req, res) => res.json(manifestComLogo(req)));

// ---------- Página de configuração ----------
app.get('/configure', (req, res) => {
    res.send(`<!DOCTYPE html>
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
  <img src="/check_tempo.jpg" alt="" style="width:72px;height:72px;display:block;margin:0 auto 8px" onerror="this.style.display='none'">
  <h2 style="text-align:center">Verificador de Streams</h2>
  <p>Entre com a sua conta do Stremio. O Verificador passa a usar automaticamente todos os addons com streams que você tiver instalados, inclusive os que instalar depois. A senha vai direto para o Stremio e não passa por este servidor.</p>
  <input type="email" id="email" placeholder="E-mail do Stremio">
  <input type="password" id="senha" placeholder="Senha">
  <button onclick="entrar()">Entrar e gerar link</button>
  <div id="msg"></div>
  <div id="resultado" style="display:none">
    <p>Link do addon (cole em Stremio &gt; Addons &gt; campo de busca/URL, ou use os botões):</p>
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
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(campo.value).then(function () { msg('Link copiado!'); }, function () { document.execCommand('copy'); msg('Link copiado!'); });
  } else {
    document.execCommand('copy');
    msg('Link copiado!');
  }
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
    caminho = window.location.host + '/' + b64u(JSON.stringify({ k: j.result.authKey })) + '/manifest.json';
    document.getElementById('link').value = window.location.protocol + '//' + caminho;
    document.getElementById('resultado').style.display = 'block';
    msg('Pronto. Copie o link ou instale direto.');
  } catch (e) {
    msg('Erro: ' + e.message);
  }
}
</script>
</body>
</html>`);
});

// ---------- Cinemeta ----------
const cacheMeta = new Map();
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
        console.error('[CINEMETA ERRO]:', err.message);
        return null;
    }
}

// Streams de um addon, com cache curto para não repetir o mesmo pedido
const cacheStreams = new Map();
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

// ---------- Validação ----------
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

async function handleStreams(req, res) {
    const { type, id } = req.params;
    const t0 = Date.now();

    // Cinemeta começa já, em paralelo com a busca da lista de addons
    const metaP = fetchCinemeta(type, id);
    const addons = await listaDeAddons(req.params.config, req.hostname, type, id);

    console.log(`\n[STREAM] ${type} | ${id} | ${addons.length} addons`);

    if (addons.length === 0) {
        console.log('[AVISO] Nenhum addon configurado (instale pelo /configure ou defina a variável ADDONS).');
        return res.json({ streams: [] });
    }

    // Todos os addons ao mesmo tempo, sem esperar pelo Cinemeta
    const addonsP = addons.map(a => streamsDoAddon(a, type, id));
    const [meta, resultados] = await Promise.all([metaP, Promise.allSettled(addonsP)]);

    const tituloOficial = meta && meta.name ? meta.name : '';
    const palavras = palavrasDoTitulo(tituloOficial);
    console.log(`[TÍTULO OFICIAL] ${tituloOficial || 'Desconhecido'}`);

    const streams = [];
    resultados.forEach((r, i) => {
        const a = addons[i];
        if (r.status !== 'fulfilled') {
            console.error(`[ERRO] ${a.n}: ${r.reason && r.reason.message}`);
            return;
        }
        let ruins = 0;
        r.value.forEach(s => {
            const incorreto = streamIncorreto(s, palavras);
            if (incorreto) ruins++;
            streams.push(marcar(s, a.n, incorreto));
        });
        console.log(`[OK] ${a.n}: ${r.value.length} streams, ${ruins} suspeitos`);
    });

    console.log(`[TEMPO] ${Date.now() - t0} ms`);
    res.json({ streams, cacheMaxAge: 120 });
}

app.get('/stream/:type/:id.json', handleStreams);
app.get('/:config/stream/:type/:id.json', handleStreams);

app.listen(PORT, () => console.log(`Verificador v6.2.0 ativo na porta ${PORT}`));
