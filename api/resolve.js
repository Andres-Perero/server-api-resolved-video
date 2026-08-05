// api/resolve.js

export default async function handler(req, res) {
  const { embedUrl } = req.query;

  if (!embedUrl) {
    return res.status(400).json({ error: 'Debes proporcionar la URL del embed (?embedUrl=...)' });
  }

  try {
    const htmlRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://vimeos.net/'
      }
    });

    const html = await htmlRes.text();

    // Búsqueda mediante expresiones regulares de la estructura m3u8 de Vimeos
    const m3u8Match = html.match(/(https?:\/\/[^"\']+(?:master\.m3u8|\.urlset\/master\.m3u8)[^"\']*)/i);

    if (!m3u8Match) {
      return res.status(404).json({
        error: 'No se pudo extraer la URL directa vía Regex. El embed requiere evaluación con navegador (Playwright).'
      });
    }

    const rawM3u8 = m3u8Match[1];
    const proxiedUrl = `https://${req.headers.host}/api/stream?url=${encodeURIComponent(rawM3u8)}`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      success: true,
      rawUrl: rawM3u8,
      streamUrl: proxiedUrl
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}