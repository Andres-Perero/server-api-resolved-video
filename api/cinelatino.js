/**
 * Vercel API Route: /api/cinelatino
 * Resuelve embed de play.cinelatino.net → URL /stream/
 *
 * GET /api/cinelatino?url=https://play.cinelatino.net/embed.php?data=...
 */

function unpackPacker(html) {
  // Extrae payload + diccionario del packer típico de JWPlayer
  const m = html.match(
    /\}\('((?:\\'|[^'])*)',\s*(\d+),\s*(\d+),\s*'((?:\\'|[^'])*)'\.split\('\|'\)/s
  );
  if (!m) return null;

  const payload = m[1];
  const a = parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const k = m[4].split('|');

  function e(cVal) {
    return (cVal < a ? '' : e(Math.floor(cVal / a))) +
      ((cVal = cVal % a) > 35 ? String.fromCharCode(cVal + 29) : cVal.toString(36));
  }

  const d = {};
  for (let i = 0; i < c; i++) {
    const key = e(i);
    d[key] = k[i] || key;
  }

  // Reemplazar tokens
  let unpacked = payload.replace(/\b\w+\b/g, (word) => d[word] || word);
  return unpacked;
}

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
      error: 'URL de CineLatino inválida',
    });
  }

  try {
    // Ya es stream → devolver directo
    if (url.includes('/stream/')) {
      return res.status(200).json({
        success: true,
        url,
        type: 'mp4',
        source: 'direct-stream',
      });
    }

    const embedRes = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
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

    if (html.includes('Contenido Protegido') || html.includes('hotlinking')) {
      return res.status(403).json({
        success: false,
        error: 'Contenido protegido (Referer inválido)',
      });
    }

    let streamUrl = null;

    // 1) URL completa ya visible
    let m = html.match(
      /https?:\/\/play\.cinelatino\.net\/+stream\/\?data=([A-Za-z0-9+/=_-]{20,})/i
    );
    if (m) {
      streamUrl = `https://play.cinelatino.net//stream/?data=${m[1]}`;
    }

    // 2) Unpack del packer y buscar file / data=
    if (!streamUrl) {
      const unpacked = unpackPacker(html);
      if (unpacked) {
        // Buscar data=... completo (puede contener /)
        m = unpacked.match(/data=([A-Za-z0-9+/=_-]{30,})/i);
        if (m) {
          streamUrl = `https://play.cinelatino.net//stream/?data=${m[1]}`;
        } else {
          // Buscar cualquier https://play... 
          m = unpacked.match(/https?:\/\/play\.[^"'\s]+stream[^"'\s]*/i);
          if (m) {
            // Reconstruir dominio correcto
            streamUrl = m[0]
              .replace(/play\.[a-z.]+\/+/, 'play.cinelatino.net//')
              .replace(/\/2g\//, '/stream/')
              .replace(/\/stream\/\//, '/stream/');
          }
        }
      }
    }

    // 3) Fallback: juntar tokens largos del diccionario que parezcan el data
    if (!streamUrl) {
      const dictMatch = html.match(/'([^']{100,})'\.split\('\|'\)/);
      if (dictMatch) {
        const words = dictMatch[1].split('|');
        // Buscar el token más largo que parezca base64url
        const candidates = words
          .filter((w) => w.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(w))
          .sort((a, b) => b.length - a.length);
        if (candidates.length) {
          // A veces el data está partido en 2-3 piezas; las juntamos si están cerca
          streamUrl = `https://play.cinelatino.net//stream/?data=${candidates[0]}`;
        }
      }
    }

    if (!streamUrl) {
      return res.status(404).json({
        success: false,
        error: 'No se pudo extraer la URL del stream desde el embed',
        tip: 'Prueba con el script de Playwright (test-resolve-cinelatino-v2.js)',
      });
    }

    // Limpieza final
    streamUrl = streamUrl
      .replace(/\\+/g, '')
      .replace(/play\.cinelatino\.net\/{3,}/, 'play.cinelatino.net//');

    return res.status(200).json({
      success: true,
      url: streamUrl,
      type: 'mp4',
      source: 'resolved-from-embed',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno',
    });
  }
}
