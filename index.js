// Definição atualizada da regex para capturar resoluções e termos comuns de release em torrents
const MARCA_RELEASE = /\b(bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|hdrip|x264|x265|h264|h265|hevc|remux|1080p|720p|2160p|4k|hdr|dv)\b/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Rota de Diagnóstico para testar se as chaves estão configuradas corretamente
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

    // Tratamento principal dos streams do Stremio
    if (url.pathname.startsWith('/stream/')) {
      try {
        // Exemplo de lógica para interceptar e validar os streams
        // Certifique-se de manter a sua lógica original de fetch do addon de origem aqui embaixo
        
        // Se as chaves estiverem configuradas, aplica a verificação
        if (env.TMDB_KEY && env.SECRET) {
          // Insira sua lógica de processamento de streams aqui, usando a nova MARCA_RELEASE
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Addon Stremio Worker Rodando!', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};