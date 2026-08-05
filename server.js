import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { resolveVimeosEmbed } from './resolvers/vimeos.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let browser;

// 1. Endpoint principal con Playwright (Resuelve JS + JWPlayer)
app.get('/api/resolve-playwright', async (req, res) => {
  const embedUrl = req.query.url;
  if (!embedUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido (?url=...)' });
  }

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'es-ES'
    });

    const result = await resolveVimeosEmbed(context, embedUrl);

    if (result && result.url) {
      // Formateamos la URL proxy basándonos en el Host actual del servidor
      const proxiedStreamUrl = `${req.protocol}://${req.get('host')}/api/stream?url=${encodeURIComponent(result.url)}`;

      return res.json({
        type: result.type,
        url: proxiedStreamUrl, // URL que consume hls.js en webOS
        rawUrl: result.url,    // URL real extraída
        tracks: result.tracks,
        resolvedAt: result.resolvedAt
      });
    }

    return res.status(404).json({ error: 'No se pudo resolver el .m3u8' });
  } catch (error) {
    console.error('Error en /api/resolve-playwright:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 2. Endpoint por Regex (Ligero, sin Playwright)
app.get('/api/resolve', async (req, res) => {
  const embedUrl = req.query.embedUrl || req.query.url;
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
    const m3u8Match = html.match(/(https?:\/\/[^"'\s]+(?:master\.m3u8|\.urlset\/master\.m3u8)[^"'\s]*)/i);

    if (!m3u8Match) {
      return res.status(404).json({
        error: 'No se pudo extraer la URL directa vía Regex. Usa /api/resolve-playwright.'
      });
    }

    const rawM3u8 = m3u8Match[1];
    const proxiedUrl = `${req.protocol}://${req.get('host')}/api/stream?url=${encodeURIComponent(rawM3u8)}`;

    return res.status(200).json({
      success: true,
      rawUrl: rawM3u8,
      streamUrl: proxiedUrl
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. Proxy Stream (Bypass Anti-403 y reescritura de segmentos m3u8 para webOS)
app.get('/api/stream', async (req, res) => {
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

    // Reescribe las URLs internas del manifiesto HLS para redirigirlas a través de tu proxy
    if (targetUrl.includes('.m3u8')) {
      let text = new TextDecoder().decode(data);
      const hostUrl = `${req.protocol}://${req.get('host')}/api/stream?url=`;

      text = text.replace(/(https?:\/\/[^\s"\']+)/g, (match) => {
        return `${hostUrl}${encodeURIComponent(match)}`;
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(text);
    }

    // Retorna segmentos .ts y archivos de subtítulos .vtt
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(Buffer.from(data));

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Arranca el servidor Express escuchando en 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de resolución activo en el puerto ${PORT}`);
});