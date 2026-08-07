import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════════
// SESIONES DE PLAYWRIGHT PERSISTENTES
// Cada sesión = un navegador abierto con su propio contexto
// ═══════════════════════════════════════════════════════════════
const sessions = new Map(); // sessionId → { browser, context, page, referer, lastUsed }

// Limpiar sesiones inactivas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsed > 15 * 60 * 1000) { // 15 minutos
      session.browser.close().catch(() => {});
      sessions.delete(id);
      console.log(`[SESSION] Eliminada sesión inactiva: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// PATRONES BLOQUEADOS PARA VIMEOS
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// CREAR SESIÓN DE PLAYWRIGHT
// ═══════════════════════════════════════════════════════════════
async function createSession(sessionId, embedUrl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "es-ES",
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  // Bloquear ads, anti-devtool, trackers
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (VIMEOS_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  const hlsHits = [];
  page.on('response', (res) => {
    const url = res.url();
    if (/master\.m3u8|\.urlset\/master\.m3u8/.test(url)) {
      hlsHits.push(url);
    }
  });

  // Navegar al embed
  await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Cerrar interstitial
  const clickCandidates = ['text=Empezar desde el inicio', 'text=Continuar viendo', 'text=Resume'];
  for (const selector of clickCandidates) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  // Esperar JWPlayer
  await page.waitForFunction(
    () => { try { return typeof jwplayer === 'function' && jwplayer().getConfig?.(); } catch { return false; } },
    { timeout: 15000 }
  ).catch(() => {});

  // Extraer datos del JWPlayer
  const mediaData = await page.evaluate(() => {
    try {
      const player = jwplayer();
      const config = player.getConfig?.() || {};
      const playlist = player.getPlaylist?.()?.[0] || {};

      const tracks = (playlist.tracks || config.tracks || [])
        .filter((t) => t.kind === 'captions' || t.kind === 'subtitles')
        .map((t) => ({ label: t.label || 'Unknown', file: t.file, lang: t.lang || 'es' }));

      const audioTracks = (player.getAudioTracks?.() || []).map((a) => ({
        id: a.id,
        label: a.name || a.label
      }));

      const file = playlist.sources?.[0]?.file || config.sources?.[0]?.file || null;

      return { file, tracks, audioTracks };
    } catch {
      return { file: null, tracks: [], audioTracks: [] };
    }
  }).catch(() => ({ file: null, tracks: [], audioTracks: [] }));

  const finalUrl = mediaData.file || hlsHits[0] || null;

  const parsedEmbed = new URL(embedUrl);
  const refererHost = `${parsedEmbed.protocol}//${parsedEmbed.host}/`;

  if (!finalUrl) {
    await browser.close();
    return null;
  }

  // Guardar sesión
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
    referer: refererHost,
    sessionId: sessionId,
    resolvedAt: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Resolver embed (crea sesión persistente)
// GET /api/resolve?url=https://vimeos.net/embed-xxx.html
// ═══════════════════════════════════════════════════════════════
app.get("/api/resolve", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const embedUrl = req.query.url;

  if (!embedUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido' });
  }

  try {
    if (embedUrl.includes("vimeos")) {
      const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      const result = await createSession(sessionId, embedUrl);

      if (!result) {
        return res.status(404).json({ error: "No se pudo resolver el stream" });
      }

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
// ENDPOINT: Proxy CORS usando sesión de Playwright
// GET /api/proxy?session=xxx&url=https://...
// ═══════════════════════════════════════════════════════════════
app.get("/api/proxy", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const sessionId = req.query.session;
  const targetUrl = req.query.url;
  const referer = req.query.referer;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido' });
  }

  // Si hay sesión, usar Playwright para hacer la petición
  // Si no hay sesión, usar fetch normal (fallback)
  const session = sessionId ? sessions.get(sessionId) : null;

  try {
    let response;
    let responseBody;
    let contentType;

    if (session) {
      // USAR PLAYWRIGHT: la misma sesión que resolvió el embed
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
      // FALLBACK: fetch normal con headers
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

    // ─── M3U8: reescribir TODAS las URLs ─────────────────────
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

    // ─── Subtítulos VTT/SRT ──────────────────────────────────
    if (contentType.includes('text/vtt') || contentType.includes('text/srt') || targetUrl.includes('.vtt') || targetUrl.includes('.srt')) {
      return res.send(responseBody.toString('utf-8'));
    }

    // ─── Segmentos .ts, .m4s: stream binario ─────────────────
    res.setHeader('Content-Length', responseBody.length);
    res.send(responseBody);

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(502).json({ error: 'Proxy failed', message: err.message });
  }
});

// Preflight CORS
app.options('/api/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════
// SPA fallback
// ═══════════════════════════════════════════════════════════════
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  console.log(`📡 API Resolve: http://localhost:${PORT}/api/resolve?url=...`);
  console.log(`📡 API Proxy:  http://localhost:${PORT}/api/proxy?session=...&url=...`);
});