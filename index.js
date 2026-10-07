export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Tratar requisições OPTIONS (CORS pré-voo exigido pelo Stremio)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    const pathParts = url.pathname.split('/');

    // 2. Rota da Tela de Configuração (Página Inicial) com os 3 botões
    if (url.pathname === '/' || url.pathname === '/configure') {
      return new Response(getHtmlConfigPage(url.host), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // 3. Rota do Manifesto do Stremio
    if (url.pathname === '/manifest.json') {
      const manifest = {
        id: 'org.stremio.addonfiltrado',
        version: '1.0.0',
        name: 'Addon Filtrado (Stremio)',
        description: 'Addon inteligente que remove automaticamente streams incorretos.',
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

    // 4. Rota de Streams (Busca, Valida e Filtra a lista)
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

    return new Response('Rota não encontrada', { status: 404 });
  }
};

/**
 * Gera a página HTML de configuração com os botões: Instalar App, Instalar Web e Copiar Link
 */
function getHtmlConfigPage(host) {
  const stremioInstallUrl = `stremio://${host}/manifest.json`;
  const stremioWebUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`https://${host}/manifest.json`)}`;
  const httpsManifestUrl = `https://${host}/manifest.json`;

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuração - Addon Filtrado</title>
    <style>
      body { font-family: Arial, sans-serif; background: #121212; color: #fff; text-align: center; padding: 40px; margin: 0; }
      .container { max-width: 520px; margin: 0 auto; background: #1e1e1e; padding: 35px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.7); }
      h1 { color: #e50914; margin-bottom: 10px; font-size: 24px; }
      p { color: #aaa; font-size: 14px; margin-bottom: 30px; line-height: 1.5; }
      .btn-group { display: flex; flex-direction: column; gap: 12px; margin-bottom: 25px; }
      .btn { display: block; background: #e50914; color: #fff; padding: 14px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; transition: background 0.2s, transform 0.1s; border: none; cursor: pointer; }
      .btn:hover { background: #b20710; }
      .btn-web { background: #2d2d2d; border: 1px solid #444; }
      .btn-web:hover { background: #3d3d3d; }
      .btn-copy { background: #2563eb; }
      .btn-copy:hover { background: #1d4ed8; }
      .link-box { font-size: 12px; word-break: break-all; background: #161616; padding: 12px; border-radius: 6px; color: #888; border: 1px solid #333; }
      #toast { margin-top: 10px; font-size: 12px; color: #4ade80; display: none; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Addon Filtrado</h1>
      <p>Remove automaticamente da lista qualquer stream com duração ou conteúdo incorreto antes de exibi-lo no Stremio.</p>
      
      <div class="btn-group">
        <!-- 1. Instalar no Aplicativo (Desktop / Android App) -->
        <a class="btn" href="${stremioInstallUrl}">Instalar no App (Stremio Desktop/Mobile)</a>
        
        <!-- 2. Instalar na Versão Web -->
        <a class="btn btn-web" href="${stremioWebUrl}" target="_blank">Instalar na Versão Web</a>
        
        <!-- 3. Copiar Link do Manifesto -->
        <button class="btn btn-copy" onclick="copiarLink()">Copiar Link do Manifesto</button>
      </div>

      <div class="link-box" id="manifest-link">${httpsManifestUrl}</div>
      <div id="toast">Link copiado para a área de transferência!</div>
    </div>

    <script>
      function copiarLink() {
        const link = document.getElementById('manifest-link').innerText;
        navigator.clipboard.writeText(link).then(() => {
          const toast = document.getElementById('toast');
          toast.style.display = 'block';
          setTimeout(() => {
            toast.style.display = 'none';
          }, 3000);
        });
      }
    </script>
  </body>
  </html>`;
}

async function buscarStreamsDoProvedor(type, id, env) {
  try {
    const respostaProvedor = await fetch(`https://torrentio.strem.fun/stream/${type}/${id}.json`, {
      headers: { 'User-Agent': 'StremioAddon/1.0.0' }
    });
    if (!respostaProvedor.ok) return [];
    const dados = await respostaProvedor.json();
    return dados.streams || [];
  } catch (err) {
    return [];
  }
}

async function filtrarStreamsInvalidos(streams, imdbId, env) {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  const promessasVerificacao = streams.map(async (stream) => {
    const ehValido = await verificarDuracaoOuConteudo(stream, imdbId);
    return { stream, valido: ehValido };
  });

  const resultados = await Promise.all(promessasVerificacao);

  return resultados
    .filter(item => item.valido)
    .map(item => item.stream);
}

async function verificarDuracaoOuConteudo(stream, imdbId) {
  try {
    // Insira aqui a sua regra de validação real
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false; 
    }
    return true;
  } catch (err) {
    return false;
  }
}