// api/stream.js

export default async function handler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta el parámetro url');

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://vimeos.net/',
        'Origin': 'https://vimeos.net'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Error CDN Vimeos: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    const data = await response.arrayBuffer();

    // Si es un manifiesto .m3u8, reescribimos los enlaces internos para pasarlos por el proxy
    if (targetUrl.includes('.m3u8')) {
      let text = new TextDecoder().decode(data);
      const hostUrl = `https://${req.headers.host}/api/stream?url=`;

      text = text.replace(/(https?:\/\/[^\s"\']+)/g, (match) => {
        return `${hostUrl}${encodeURIComponent(match)}`;
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(text);
    }

    // Para segmentos de video (.ts) y subtítulos (.vtt)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(Buffer.from(data));

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}