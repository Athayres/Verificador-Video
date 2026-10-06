const MARCA_RELEASE = /\b(bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|hdrip|x264|x265|h264|h265|hevc|remux|1080p|720p|2160p|4k|hdr|dv)\b/i;

const MANIFEST = {
  id: 'org.stremio.workeraddon',
  version: '1.0.0',
  name: 'Addon Verificador Worker',
  description: 'Addon customizado para filtragem e verificação de streams.',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt']
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Página de Configuração / Instalação (Raiz ou /configure)
    if (url.pathname === '/' || url.pathname === '/configure') {
      const htmlContent = `<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Configuração - Addon Stremio</title>
          <style>
              body {
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                  background-color: #121212;
                  color: #e0e0e0;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
              }
              .card {
                  background-color: #1e1e1e;
                  padding: 40px;
                  border-radius: 12px;
                  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                  text-align: center;
                  max-width: 420px;
                  width: 100%;
              }
              h1 {
                  font-size: 22px;
                  margin-bottom: 10px;
                  color: #ab65f7;
              }
              p {
                  color: #9e9e9e;
                  font-size: 14px;
                  margin-bottom: 25px;
                  line-height: 1.5;
              }
              .btn {
                  display: inline-block;
                  background-color: #ab65f7;
                  color: white;
                  padding: 12px 28px;
                  text-decoration: none;
                  border-radius: 6px;
                  font-weight: bold;
                  font-size: 15px;
                  transition: background 0.2s, transform 0.1s;
              }
              .btn:hover {
                  background-color: #954fe3;
                  transform: translateY(-2px);
              }
              .status {
                  margin-top: 20px;
                  font-size: 12px;
                  color: #4caf50;
              }
          </style>
      </head>
      <body>
          <div class="card">
              <h1>Addon Stremio Ativo</h1>
              <p>Este addon está rodando perfeitamente no Cloudflare Worker. Clique no botão abaixo para instalá-lo no seu Stremio.</p>
              <a href="#" id="installBtn" class="btn">Instalar no Stremio</a>
              <div class="status">● Sistema Operacional</div>
          </div>
          <script>
              const host = window.location.host;
              // Transforma a URL atual no protocolo de instalação do Stremio
              const manifestUrl = 'https://' + host + '/manifest.json';
              document.getElementById('installBtn').href = 'stremio://' + host + '/manifest.json';
          </script>
      </body>
      </html>`;

      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // 2. Rota do Manifesto obrigatório do Stremio
    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. Rota de Diagnóstico
    if (url.pathname === '/diagnostico') {
      const tmdbOk = !!env.TMDB_KEY;
      const secretOk = !!env.SECRET;
      let tmdbTeste = 'não testado';

      if (tmdbOk) {
        try {
          const res = await fetch(`https://api.themoviedb.org/3/movie/550?api_key=${env.TMDB_KEY}`);
          tmdbTeste = res.ok ? 'ok' : `erro HTTP ${res.status}`;
        } catch (e) {
          tmdbTeste = `falha: ${e.message}`;
        }
      }

      return new Response(JSON.stringify({
        tmdb_key_definida: tmdbOk,
        secret_definida: secretOk,
        tmdb_teste: tmdbTeste
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. Tratamento principal de Streams
    if (url.pathname.startsWith('/stream/')) {
      try {
        if (env.TMDB_KEY && env.SECRET) {
          // Insira sua lógica de streams aqui
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Página não encontrada', { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};