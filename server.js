import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// CORS FORZADO EN TODAS LAS RESPUESTAS (incluso errores)
// ═══════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
  next();
});

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS", "HEAD"], allowedHeaders: ["*"], credentials: false }));
app.use(express.static(path.join(__dirname, "public")));

// Preflight OPTIONS para todas las rutas
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════
// SESIONES DE PLAYWRIGHT PERSISTENTES
// ═══════════════════════════════════════════════════════════════
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsed > 15 * 60 * 1000) {
      session.browser.close().catch(() => {});
      sessions.delete(id);
      console.log(`[SESSION] Eliminada sesión inactiva: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// PATRONES BLOQUEADOS PARA HLSWish / StreamHG
// ═══════════════════════════════════════════════════════════════
const HLSWISH_BLOCKED_PATTERNS = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'ads.',
  'analytics.',
  'facebook.com/tr',
  'connect.facebook.net',
  'twitter.com',
  'linkedin.com',
  'tiktok.com',
  'cdn.jsdelivr.net/npm/disable-devtool',
  'imasdk.googleapis.com',
  'cdn.jsdelivr.net/npm/ima-ad-player',
  '.mp4'  // evitar descargas de mp4 directos que pueden ralentizar
];

// ═══════════════════════════════════════════════════════════════
// CREAR SESIÓN DE PLAYWRIGHT PARA HLSWish
// ═══════════════════════════════════════════════════════════════
async function createHLSWishSession(sessionId, embedUrl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "es-ES",
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (HLSWISH_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  // Capturar M3U8 desde network requests
  const hlsHits = [];
  page.on('response', (res) => {
    const url = res.url();
    if (/\.m3u8/.test(url) && !url.includes('workers.dev')) {
      hlsHits.push(url);
    }
  });

  await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Intentar hacer click en botones de play si existen
  const clickCandidates = ['text=Play', 'text=Reproducir', 'text=Start', '.jw-icon-playback', '[aria-label="Play"]'];
  for (const selector of clickCandidates) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Esperar a que el packer se ejecute y el player esté listo
  await page.waitForFunction(
    () => { 
      try { 
        return (typeof jwplayer === 'function' && jwplayer().getConfig?.()) ||
               (typeof player === 'object' && player.getConfig?.());
      } catch { 
        return false; 
      } 
    },
    { timeout: 15000 }
  ).catch(() => {});

  // Extraer datos del player
  const mediaData = await page.evaluate(() => {
    try {
      // Intentar jwplayer primero
      let player = null;
      let config = null;
      
      if (typeof jwplayer === 'function') {
        player = jwplayer();
        config = player.getConfig?.() || {};
      } else if (typeof player === 'object' && player.getConfig) {
        config = player.getConfig();
      }

      const playlist = (config.playlist && config.playlist[0]) || config || {};
      const sources = playlist.sources || config.sources || [];
      
      // Buscar source HLS
      let file = null;
      for (const src of sources) {
        if (src.file && (src.file.includes('.m3u8') || src.type === 'hls')) {
          file = src.file;
          break;
        }
      }
      
      // Fallback: buscar en variables globales comunes de HLSWish
      if (!file && window.sources) {
        for (const key in window.sources) {
          if (window.sources[key] && window.sources[key].includes('.m3u8')) {
            file = window.sources[key];
            break;
          }
        }
      }
      
      if (!file && window.file) {
        file = window.file;
      }

      // Extraer tracks de subtítulos
      const tracks = (playlist.tracks || config.tracks || [])
        .filter((t) => t.kind === 'captions' || t.kind === 'subtitles')
        .map((t) => ({ 
          label: t.label || 'Unknown', 
          file: t.file, 
          lang: t.lang || 'es',
          kind: t.kind 
        }));

      // Extraer tracks de audio
      const audioTracks = [];
      if (player && player.getAudioTracks) {
        const at = player.getAudioTracks();
        for (const a of at) {
          audioTracks.push({ id: a.id, label: a.name || a.label || a.language });
        }
      }

      // Extraer poster/imagen
      let poster = playlist.image || config.image || null;

      return { file, tracks, audioTracks, poster };
    } catch (e) {
      return { file: null, tracks: [], audioTracks: [], poster: null };
    }
  }).catch(() => ({ file: null, tracks: [], audioTracks: [], poster: null }));

  // También buscar en el HTML por si el packer creó variables globales
  const htmlData = await page.evaluate(() => {
    // Buscar variables comunes que deja el packer de HLSWish
    const vars = ['sources', 'links', 'file', 'video_url', 'stream_url'];
    const found = {};
    for (const v of vars) {
      if (window[v]) found[v] = window[v];
    }
    return found;
  }).catch(() => ({}));

  // Si no encontramos file en el player, buscar en variables globales
  let finalUrl = mediaData.file;
  if (!finalUrl && htmlData.sources) {
    if (typeof htmlData.sources === 'object') {
      // links = {hls2: "...", hls4: "..."}
      const order = ['hls4', 'hls2', 'hls3'];
      for (const key of order) {
        if (htmlData.sources[key]) {
          finalUrl = htmlData.sources[key];
          break;
        }
      }
    } else if (typeof htmlData.sources === 'string') {
      finalUrl = htmlData.sources;
    }
  }
  if (!finalUrl && htmlData.file) finalUrl = htmlData.file;
  if (!finalUrl && htmlData.links) {
    const order = ['hls4', 'hls2', 'hls3'];
    for (const key of order) {
      if (htmlData.links[key]) {
        finalUrl = htmlData.links[key];
        break;
      }
    }
  }

  // Fallback: usar M3U8 capturado de network
  if (!finalUrl && hlsHits.length > 0) {
    finalUrl = hlsHits[0];
  }

  const parsedEmbed = new URL(embedUrl);
  const refererHost = `${parsedEmbed.protocol}//${parsedEmbed.host}/`;

  if (!finalUrl) {
    await browser.close();
    return null;
  }

  sessions.set(sessionId, { 
    browser, 
    context, 
    page, 
    referer: refererHost,
    lastUsed: Date.now() 
  });

  return {
    type: 'hls',
    url: finalUrl,
    tracks: mediaData.tracks,
    audioTracks: mediaData.audioTracks,
    poster: mediaData.poster,
    referer: refererHost,
    sessionId: sessionId,
    resolvedAt: new Date().toISOString()
  };
}
// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Health check
// ═══════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), sessions: sessions.size });
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Resolver embed
// GET /api/resolve?url=...  o  ?embedUrl=...
// ═══════════════════════════════════════════════════════════════
app.get("/api/resolve", async (req, res) => {
  const embedUrl = req.query.url || req.query.embedUrl;

  if (!embedUrl) {
    return res.status(400).json({ error: 'Parámetro "url" o "embedUrl" requerido' });
  }

  try {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    if (embedUrl.includes("vimeos")) {
      const result = await createSession(sessionId, embedUrl);
      if (!result) return res.status(404).json({ error: "No se pudo resolver el stream" });
      return res.json(result);

    } else if (embedUrl.includes("hlswish") || embedUrl.includes("streamwish") || embedUrl.includes("streamhg")) {
      const result = await createHLSWishSession(sessionId, embedUrl);
      if (!result) return res.status(404).json({ error: "No se pudo resolver el stream de HLSWish" });
      return res.json(result);

    } else if (embedUrl.includes("goodstream")) {
      return res.json({
        type: 'hls',
        url: null,
        serverName: 'goodstream',
        message: 'Usar Worker de GoodStream en el frontend'
      });
    } else {
      return res.status(400).json({ error: 'Servidor no soportado' });
    }

  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Proxy CORS
// GET /api/proxy?session=xxx&url=https://...
// ═══════════════════════════════════════════════════════════════
app.get("/api/proxy", async (req, res) => {
  const sessionId = req.query.session;
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido' });
  }

  const session = sessionId ? sessions.get(sessionId) : null;

  try {
    let response;
    let responseBody;
    let contentType;

    if (session) {
      session.lastUsed = Date.now();

      response = await session.page.evaluate(async (url) => {
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept': '*/*',
            'Accept-Language': 'es-ES,es;q=0.9'
          }
        });

        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        const buffer = await res.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

        return {
          status: res.status,
          contentType: contentType,
          base64: base64
        };
      }, targetUrl);

      if (response.status !== 200) {
        return res.status(response.status).send(`Upstream error: ${response.status}`);
      }

      contentType = response.contentType;
      responseBody = Buffer.from(response.base64, 'base64');

    } else {
      const fetchRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': referer || 'https://vimeos.net/',
          'Origin': referer ? new URL(referer).origin : 'https://vimeos.net',
          'Accept': '*/*',
          'Accept-Language': 'es-ES,es;q=0.9'
        }
      });

      if (!fetchRes.ok) {
        return res.status(fetchRes.status).send(`Upstream error: ${fetchRes.status}`);
      }

      contentType = fetchRes.headers.get('content-type') || 'application/octet-stream';
      responseBody = Buffer.from(await fetchRes.arrayBuffer());
    }

    res.setHeader('Content-Type', contentType);

    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8')) {
      const text = responseBody.toString('utf-8');

      const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?` + 
        (sessionId ? `session=${sessionId}&` : `referer=${encodeURIComponent(referer || 'https://vimeos.net/')}&`) + 
        `url=`;

      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const lines = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;

        let absoluteUrl;
        if (trimmed.startsWith('http')) {
          absoluteUrl = trimmed;
        } else if (trimmed.startsWith('/')) {
          absoluteUrl = new URL(trimmed, baseUrl).origin + trimmed;
        } else {
          absoluteUrl = new URL(trimmed, baseUrl).href;
        }

        return proxyBase + encodeURIComponent(absoluteUrl);
      });

      return res.send(lines.join('\n'));
    }

    if (contentType.includes('text/vtt') || contentType.includes('text/srt') || targetUrl.includes('.vtt') || targetUrl.includes('.srt')) {
      return res.send(responseBody.toString('utf-8'));
    }

    res.setHeader('Content-Length', responseBody.length);
    res.send(responseBody);

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(502).json({ error: 'Proxy failed', message: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  console.log(`📡 Health:    http://localhost:${PORT}/health`);
  console.log(`📡 Resolve:   http://localhost:${PORT}/api/resolve?url=...`);
  console.log(`📡 Proxy:     http://localhost:${PORT}/api/proxy?session=...&url=...`);
});