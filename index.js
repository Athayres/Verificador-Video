export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');

    // Rota de stream do Stremio: /stream/type/id.json
    if (pathParts[1] === 'stream' && pathParts[2] && pathParts[3]) {
      const type = pathParts[2];
      const id = pathParts[3].replace('.json', '');

      try {
        // 1. Busca os streams originais do provedor
        const streamsOriginais = await buscarStreamsDoProvedor(type, id, env);

        // 2. Valida e remove os inválidos da lista
        const streamsValidos = await filtrarStreamsInvalidos(streamsOriginais, id, env);

        // 3. Retorna apenas a lista limpa para o Stremio
        return new Response(JSON.stringify({ streams: streamsValidos }), {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ streams: [], error: error.message }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8', 
            'Access-Control-Allow-Origin': '*' 
          }
        });
      }
    }

    return new Response('Addon de Filtragem Ativo!', { status: 200 });
  }
};

async function buscarStreamsDoProvedor(type, id, env) {
  const respostaProvedor = await fetch(`https://torrentio.strem.fun/stream/${type}/${id}.json`);
  const dados = await respostaProvedor.json();
  return dados.streams || [];
}

async function filtrarStreamsInvalidos(streams, imdbId, env) {
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

async function verificarDuracaoOuConteudo(stream, imdbId) {
  try {
    // Insira aqui a sua lógica de checagem real
    // Retorne `false` para apagar o stream da lista ou `true` para mantê-lo.
    
    if (stream.title && stream.title.toLowerCase().includes("errado")) {
      return false; 
    }

    return true;
  } catch (err) {
    return false; // Em caso de erro na validação, remove o stream por segurança
  }
}