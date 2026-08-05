import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { resolveVimeosEmbed } from './resolvers/vimeos.js';
import { resolveGoodstreamEmbed } from './resolvers/goodstream.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// CORS para tu dominio específico (o '*' para desarrollo)
app.use(cors({
    origin: '*', // En producción pon tu dominio exacto
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Sirve archivos estáticos desde la carpeta web-singler/
app.use(express.static(path.join(__dirname, 'web-singler')));
//app.use(express.json());

let browser;

// 1. Endpoint dinámico con Playwright
app.get('/api/resolve-playwright', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
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

    let result = null;
    let refererHost = 'https://vimeos.net/';

    // Selección de resolver según el dominio
    if (embedUrl.includes('goodstream.one')) {
      result = await resolveGoodstreamEmbed(context, embedUrl);
      if (result?.referer) refererHost = result.referer;
    } else {
      result = await resolveVimeosEmbed(context, embedUrl);
    }
if (result && result.url) {
const proxiedStreamUrl = `https://${req.get('host')}/api/stream?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(refererHost)}`;
      return res.json({
        type: result.type,
        url: proxiedStreamUrl, // URL proxificada para hls.js
        rawUrl: result.url,
        tracks: result.tracks || [],
        audioTracks: result.audioTracks || [], // Nueva propiedad devuelta
        resolvedAt: result.resolvedAt
      });
    }

    return res.status(404).json({ error: 'No se pudo resolver el enlace .m3u8' });
  } catch (error) {
    console.error('Error en /api/resolve-playwright:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 2. Proxy Stream Anti-403 con Referer Dinámico
app.get('/api/stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  const targetUrl = req.query.url;
  const customReferer = req.query.referer || 'https://vimeos.net/';

  if (!targetUrl) return res.status(400).send('Falta el parámetro url');

  try {
    const originHost = new URL(customReferer).origin;

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': customReferer,
        'Origin': originHost
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Error CDN Provider: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    const data = await response.arrayBuffer();

  // Reescritura del manifiesto m3u8
if (targetUrl.includes('.m3u8')) {
  let text = new TextDecoder().decode(data);
  //const hostUrl = `${req.protocol}://${req.get('host')}/api/stream?referer=${encodeURIComponent(customReferer)}&url=`;
const hostUrl = `https://${req.get('host')}/api/stream?referer=${encodeURIComponent(customReferer)}&url=`;
  // Obtener la URL base del archivo m3u8 para resolver URLs relativas
  const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

  // Reemplazar líneas que no comiencen con '#' (segmentos/playlists relativas y absolutas)
  const lines = text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    let absoluteSegmentUrl = trimmed;
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      absoluteSegmentUrl = new URL(trimmed, baseUrl).href;
    }

    return `${hostUrl}${encodeURIComponent(absoluteSegmentUrl)}`;
  });

  text = lines.join('\n');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  return res.status(200).send(text);
}

    // Retorno de segmentos (.ts / .vtt)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(Buffer.from(data));

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.get('/api/extract-voe', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" query parameter.' });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // Block unnecessary assets (images, stylesheets, ads) for faster execution
        await context.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
        await context.route('**/*ads*', route => route.abort());

        const page = await context.newPage();

        let streamUrl = null;

        // Monitor background network requests for m3u8/mp4 media streams
        page.on('request', request => {
            const reqUrl = request.url();
            if (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4')) {
                if (!streamUrl) streamUrl = reqUrl;
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Strategy 1: Extract direct media URL or HLS playlist from script tags
        let extractedMediaUrl = await page.evaluate(() => {
            if (typeof window.jwplayer === 'function') {
                try {
                    const player = window.jwplayer();
                    const playlist = player.getPlaylist();
                    if (playlist && playlist[0] && playlist[0].file) {
                        return playlist[0].file;
                    }
                } catch (e) {
                    // Fallback if player instance isn't globally bound
                }
            }

            // Search inline scripts for video configurations or base HLS endpoints
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const content = script.textContent || '';
                const m3u8Match = content.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
                if (m3u8Match) return m3u8Match[0];

                const mp4Match = content.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
                if (mp4Match) return mp4Match[0];
                
                // VOE specific redirect / direct variable match patterns
                const voeRedirectMatch = content.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
                if (voeRedirectMatch) return voeRedirectMatch[1];
            }

            return null;
        });

        // Strategy 2: Extract poster/storyboard thumbnail image from OpenGraph tags
        const posterUrl = await page.evaluate(() => {
            const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
            return ogImage ? ogImage.getAttribute('content') : null;
        });

        // Fallback to network intercepted video URL if DOM evaluation missed dynamic stream
        if (!extractedMediaUrl && streamUrl) {
            extractedMediaUrl = streamUrl;
        }

        await browser.close();

        if (!extractedMediaUrl) {
            return res.status(404).json({ error: 'Direct video stream URL could not be extracted.' });
        }

        return res.json({
            success: true,
            streamUrl: extractedMediaUrl,
            posterUrl: posterUrl || null
        });

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message });
    }
});

// Sirve index.html para cualquier ruta no-API (SPA behavior)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'web-singler', 'index.html'));
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});