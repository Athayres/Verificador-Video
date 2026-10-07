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

    // 2. Rota da Tela de Configuração (Página Inicial)
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
        // Busca os streams originais de forma segura
        const streamsOriginais = await buscarStreamsDoProvedor(type, id, env);

        // Valida e remove os inválidos da lista
        const streamsValidos = await filtrarStreamsInvalidos(streamsOriginais, id, env);

        // Retorna apenas a lista limpa para o Stremio
        return new Response(JSON.stringify({ streams: streamsValidos }), {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        // Em caso de erro crítico, retorna lista vazia para não quebrar o player
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
 * Gera a página HTML de configuração e instalação
 */
function getHtmlConfigPage(host) {
  const stremioInstallUrl = `stremio://${host}/manifest.json`;
  const httpsManifestUrl = `https://${host}/manifest.json`;

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuração - Addon Filtrado</title>
    <style>
      body { font-family: Arial, sans-serif; background: #121212; color: #fff; text-align: center; padding: 40px; }
      .container { max-width: 500px; margin: 0 auto; background: #1e1e1e; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.6); }
      h1 { color: #e50914; margin-bottom: 10px; }
      p { color: #aaa; font-size: 14px; margin-bottom: 25px; }
      .btn { display: inline-block; background: #e50914; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; transition: background 0.2s; }
      .btn:hover { background: #b20710; }
      .link-box { margin-top: 20px; font-size: 12px; word-break: break-all; background: #2a2a2a; padding: 10px; border-radius: 4px; color: #ccc; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Addon Filtrado</h1>
      <p>Este addon intercepta as listas de filmes e séries, removendo completamente arquivos com durações ou conteúdos incorretos.</p>
      
      <a class="btn" href="${stremioInstallUrl}">Instalar no Stremio</a>

      <div class="link-box">
        <strong>Link do Manifesto:</strong><br>
        <a href="${httpsManifestUrl}" target="_blank" style="color: #4da6ff;">${httpsManifestUrl}</a>
      </div>
    </div>
  </body>
  </html>`;
}

/**
 * Busca os streams do provedor base com User-Agent para evitar bloqueios
 */
async function buscarStreamsDoProvedor(type, id, env) {
  try {
    const respostaProvedor = await fetch(`https://torrentio.strem.fun/stream/${type}/${id}.json`, {
      headers: {
        'User-Agent': 'StremioAddon/1.0.0'
      }
    });

    if (!respostaProvedor.ok) return [];

    const dados = await respostaProvedor.json();
    return dados.streams || [];
  } catch (err) {
    return [];
  }
}

/**
 * Valida todos os streams e remove os que falharem
 */
async function filtrarStreamsInvalidos(streams, imdbId, env) {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  const promessasVerificacao = streams.map(async (stream) => {
    const ehValido = await verificarDuracaoOuConteudo(stream, imdbId);
    return { stream, valido: ehValido };
  });

  const resultados = await Promise.all(promessasVerificacao);

  // Mantém apenas os streams que retornaram true
  return resultados
    .filter(item => item.valido)
    .map(item => item.stream);
}

/**
 * Lógica individual de checagem
 */
async function verificarDuracaoOuConteudo(stream, imdbId) {
  try {
    // Insira aqui a sua regra de validação real
    // Retorne `false` para apagar o stream da lista ou `true` para mantê-lo.
    
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false; 
    }

    return true;
  } catch (err) {
    return false; // Se der erro na checagem, remove o stream por segurança
  }
}