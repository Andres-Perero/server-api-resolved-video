/**
 * Vercel API Route: /api/cinelatino
 * Resuelve embed de play.cinelatino.net → URL /stream/ lista para proxy
 *
 * Uso:
 *   GET https://server-api-resolved-video.vercel.app/api/cinelatino?url=https://play.cinelatino.net/embed.php?data=...
 *
 * Respuesta:
 *   { success: true, url: "https://play.cinelatino.net//stream/?data=...", type: "mp4" }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { url } = req.query;

  if (!url || !url.includes('cinelatino.net')) {
    return res.status(400).json({
      success: false,
      error: 'URL de CineLatino inválida (debe contener cinelatino.net)',
    });
  }

  try {
    // Si ya es /stream/, devolverla directamente
    if (url.includes('/stream/')) {
      return res.status(200).json({
        success: true,
        url: url,
        type: 'mp4',
        source: 'direct-stream',
      });
    }

    // Cargar el embed con Referer autorizado
    const embedRes = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': 'https://pelisviral.com/',
        'Origin': 'https://pelisviral.com',
      },
      redirect: 'follow',
    });

    if (!embedRes.ok) {
      return res.status(embedRes.status).json({
        success: false,
        error: `No se pudo cargar el embed (HTTP ${embedRes.status})`,
      });
    }

    const html = await embedRes.text();

    // Protección anti-hotlink
    if (html.includes('Contenido Protegido') || html.includes('hotlinking')) {
      return res.status(403).json({
        success: false,
        error: 'Contenido protegido (Referer inválido)',
      });
    }

    // Extraer la URL del stream
    let streamUrl = null;

    // 1. URL directa /stream/
    const streamMatch = html.match(
      /https?:\/\/play\.cinelatino\.net\/+stream\/\?data=[^"'\\\s]+/i
    );
    if (streamMatch) {
      streamUrl = streamMatch[0].replace(/\\+/g, '');
    }

    // 2. Dentro de "file": "..."
    if (!streamUrl) {
      const fileMatch = html.match(
        /["']file["']\s*:\s*["'](https?:\/\/play\.cinelatino\.net\/[^"']+)["']/i
      );
      if (fileMatch) streamUrl = fileMatch[1];
    }

    // 3. Patrón relativo //stream/?data=
    if (!streamUrl) {
      const relMatch = html.match(/(\/\/stream\/\?data=[A-Za-z0-9+/=_-]+)/i);
      if (relMatch) {
        streamUrl = 'https://play.cinelatino.net' + relMatch[1];
      }
    }

    // 4. Buscar en el packed eval (últimos recursos)
    if (!streamUrl) {
      const packedMatch = html.match(
        /stream\/\?data=([A-Za-z0-9+/=_-]{20,})/i
      );
      if (packedMatch) {
        streamUrl = `https://play.cinelatino.net//stream/?data=${packedMatch[1]}`;
      }
    }

    if (!streamUrl) {
      return res.status(404).json({
        success: false,
        error: 'No se pudo extraer la URL del stream desde el embed',
        tip: 'El formato del player pudo haber cambiado',
      });
    }

    // Normalizar doble slash
    streamUrl = streamUrl.replace('play.cinelatino.net///', 'play.cinelatino.net//');

    return res.status(200).json({
      success: true,
      url: streamUrl,
      type: 'mp4',
      source: 'resolved-from-embed',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno al resolver',
    });
  }
}
