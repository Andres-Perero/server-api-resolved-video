import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let browser;

// Patrones de anuncios/trackers a bloquear en Playwright
const VIMEOS_BLOCKED_PATTERNS = [
  'cdn.jsdelivr.net/npm/disable-devtool',
  'imasdk.googleapis.com',
  'cdn.jsdelivr.net/npm/ima-ad-player',
  'vimeos.net/js/pop.js',
  'vimeos.net/xd/',
  'anal.vimeos.net',
  'adangle.online',
  'xbeat.space',
  'animehack.org',
  '.mp4'
];

// Funció​​n de Playwright para resolver vimeos
async function resolveVimeosEmbed(context, embedUrl) {
  const page = await context.newPage();
  const hlsHits = [];

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (VIMEOS_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  page.on('response', (res) => {
    const url = res.url();
    if (/master\.m3u8|\.urlset\/master\.m3u8/.test(url)) {
      hlsHits.push(url);
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const clickCandidates = ['text=Empezar desde el inicio', 'text=Continuar viendo', 'text=Resume'];
    for (const selector of clickCandidates) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    await page.waitForFunction(
      () => {
        try {
          return typeof jwplayer === 'function' && jwplayer().getPlaylist?.()?.[0]?.sources?.[0]?.file;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 }
    ).catch(() => {});

    const jwSource = await page.evaluate(() => {
      try {
        const playlist = jwplayer().getPlaylist();
        const item = playlist?.[0];
        return {
          file: item?.sources?.[0]?.file || null,
          tracks: (item?.tracks || [])
            .filter((t) => t.kind === 'captions')
            .map((t) => ({ label: t.label, file: t.file }))
        };
      } catch {
        return { file: null, tracks: [] };
      }
    }).catch(() => ({ file: null, tracks: [] }));

    const finalUrl = jwSource.file || hlsHits[0] || null;

    if (!finalUrl) return null;

    return {
      type: 'hls',
      url: finalUrl,
      tracks: jwSource.tracks,
      resolvedAt: new Date().toISOString()
    };
  } finally {
    await page.close();
  }
}

// 1. Endpoint Playwright (Headless Browser)
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
      const proxiedStreamUrl = `${req.protocol}://${req.get('host')}/api/stream?url=${encodeURIComponent(result.url)}`;
      return res.json({ ...result, url: proxiedStreamUrl, rawUrl: result.url });
    }
    return res.status(404).json({ error: 'No se pudo resolver el .m3u8' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 2. Endpoint Regex Ligero (Sin Playwright)
app.get('/api/resolve', async (req, res) => {
  const embedUrl = req.query.embedUrl || req.query.url;
  if (!embedUrl) return res.status(400).json({ error: 'Debes proporcionar la URL del embed (?embedUrl=...)' });

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
        error: 'No se pudo extraer la URL directa vía Regex. Requiere /api/resolve-playwright'
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

// 3. Proxy Stream (Reescritura de fragmentos para webOS)
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
      const hostUrl = `${req.protocol}://${req.get('host')}/api/stream?url=`;

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
  console.log(`Servidor escuchando en puerto ${PORT}`);
});