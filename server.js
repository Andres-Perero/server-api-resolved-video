import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { resolveVimeosEmbed } from './api/vimeos.js'; // Tu función original con Playwright

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let browser;

// 1. Endpoint con Playwright (Para resolver embeds complejos)
app.get('/api/resolve-playwright', async (req, res) => {
  const embedUrl = req.query.url;
  if (!embedUrl) return res.status(400).json({ error: 'Parámetro "url" requerido' });

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
      const proxiedStreamUrl = `https://${req.get('host')}/api/stream?url=${encodeURIComponent(result.url)}`;
      return res.json({ ...result, url: proxiedStreamUrl, rawUrl: result.url });
    }
    return res.status(404).json({ error: 'No se pudo resolver el .m3u8' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 2. Endpoint de Stream Proxy (Anti-403 para webOS)
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

    if (!response.ok) return res.status(response.status).send(`Error CDN Vimeos: ${response.status}`);

    const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    const data = await response.arrayBuffer();

    if (targetUrl.includes('.m3u8')) {
      let text = new TextDecoder().decode(data);
      const hostUrl = `https://${req.get('host')}/api/stream?url=`;

      text = text.replace(/(https?:\/\/[^\s"\']+)/g, (match) => {
        return `${hostUrl}${encodeURIComponent(match)}`;
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(text);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(Buffer.from(data));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de resolución listo en puerto ${PORT}`);
});