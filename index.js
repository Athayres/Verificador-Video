export default {
  async fetch(request, env, ctx) {
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

    // 1. Rota da Tela de Configuração (Garante que exiba a página com os 3 botões)
    if (url.pathname === '/' || url.pathname === '/configure' || url.pathname === '') {
      return new Response(getHtmlConfigPage(url.host), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // 2. Rota do Manifesto do Stremio
    if (url.pathname === '/manifest.json') {
      const manifest = {
        id: 'org.stremio.addonfiltrado',
        version: '1.0.0',
        name: 'Addon Filtrado (Stremio)',
        description: 'Remove automaticamente da lista streams com duração ou conteúdo incorreto.',
        types: ['movie', 'series'],
        catalogs: [],
        resources: ['stream'],
        idPrefixes: ['tt']
      };
      return new Response(JSON.stringify(manifest), {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. Rota de Streams (Busca, Valida e Filtra a lista)
    const pathParts = url.pathname.split('/');
    if (pathParts[1] === 'stream' && pathParts[2] && pathParts[3]) {
      const type = pathParts[2];
      const id = pathParts[3].replace('.json', '');

      try {
        const streamsOriginais = await buscarStreamsDoProvedor(type, id, env);
        const streamsValidos = await filtrarStreamsInvalidos(streamsOriginais, id, env);

        return new Response(JSON.stringify({ streams: streamsValidos }), {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ streams: [] }), {
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8', 
            'Access-Control-Allow-Origin': '*' 
          }
        });
      }
    }

    return new Response('Página não encontrada', { status: 404 });
  }
};

/**
 * HTML limpo e garantido com os 3 botões
 */
function getHtmlConfigPage(host) {
  const stremioInstallUrl = `stremio://${host}/manifest.json`;
  const stremioWebUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`https://${host}/manifest.json`)}`;
  const httpsManifestUrl = `https://${host}/manifest.json`;

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Addon Filtrado - Stremio</title>
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
        margin-bottom: 25px;
        line-height: 1.4;
      }
      .btn {
        display: block;
        width: 100%;
        padding: 12px;
        margin-bottom: 12px;
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
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Addon Filtrado</h1>
      <p>Remove automaticamente da lista os arquivos com durações ou conteúdos incorretos.</p>
      
      <a href="${stremioInstallUrl}" class="btn btn-app">Instalar no App (Desktop/Mobile)</a>
      <a href="${stremioWebUrl}" target="_blank" class="btn btn-web">Instalar na Versão Web</a>
      <button onclick="copiarLink()" class="btn btn-copy">Copiar Link do Manifesto</button>

      <div class="link-box" id="manifestLink">${httpsManifestUrl}</div>
      <div id="toast">Link copiado com sucesso!</div>
    </div>

    <script>
      function copiarLink() {
        const link = document.getElementById('manifestLink').innerText;
        navigator.clipboard.writeText(link).then(() => {
          const toast = document.getElementById('toast');
          toast.style.display = 'block';
          setTimeout(() => { toast.style.display = 'none'; }, 3000);
        });
      }
    </script>
  </body>
  </html>`;
}

async function buscarStreamsDoProvedor(type, id, env) {
  try {
    const res = await fetch(`https://torrentio.strem.fun/stream/${type}/${id}.json`, {
      headers: { 'User-Agent': 'StremioAddon/1.0.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.streams || [];
  } catch (e) {
    return [];
  }
}

async function filtrarStreamsInvalidos(streams, imdbId, env) {
  if (!Array.isArray(streams) || streams.length === 0) return [];
  const checks = streams.map(async (stream) => {
    const valid = await verificarDuracaoOuConteudo(stream, imdbId);
    return { stream, valid };
  });
  const results = await Promise.all(checks);
  return results.filter(r => r.valid).map(r => r.stream);
}

async function verificarDuracaoOuConteudo(stream, imdbId) {
  try {
    // Adicione aqui a sua lógica de checagem real
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}