import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { resolveVimeosEmbed } from "./resolvers/vimeos.js";
import { resolveGoodstreamEmbed } from "./resolvers/goodstream.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.static(path.join(__dirname, "web-singler")));

// ═══════════════════════════════════════════════════════════════
// SESIONES DE PLAYWRIGHT PERSISTENTES
// Cada sesión = un navegador abierto con su propia IP/contexto
// ═══════════════════════════════════════════════════════════════
const sessions = new Map(); // sessionId → { context, page, lastUsed }

// Limpiar sesiones inactivas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsed > 10 * 60 * 1000) { // 10 minutos
      session.context.close().catch(() => {});
      sessions.delete(id);
      console.log(`[SESSION] Eliminada sesión inactiva: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// Crear nueva sesión de Playwright
async function createSession(sessionId, embedUrl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "es-ES",
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  // Bloquear ads y trackers
  await page.route('**/*', (route) => {
    const url = route.request().url();
    const blocked = ['ads', 'analytics', 'googletag', 'doubleclick', 'facebook', 'twitter'];
    if (blocked.some(b => url.includes(b))) {
      return route.abort();
    }
    return route.continue();
  });

  // Navegar al embed y esperar que JWPlayer cargue
  await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Esperar JWPlayer
  await page.waitForFunction(
    () => typeof window.jwplayer === 'function',
    { timeout: 10000 }
  ).catch(() => {});

  sessions.set(sessionId, { browser, context, page, embedUrl, lastUsed: Date.now() });
  return sessions.get(sessionId);
}

// ═══════════════════════════════════════════════════════════════
// RESOLVER EMBED (crea sesión y devuelve sessionId)
// ═══════════════════════════════════════════════════════════════
app.get("/api/resolve-playwright", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const embedUrl = req.query.url;
  if (!embedUrl) return res.status(400).json({ error: 'Parámetro "url" requerido' });

  try {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    if (embedUrl.includes("goodstream.one")) {
      // Crear sesión persistente para GoodStream
      const session = await createSession(sessionId, embedUrl);

      // Extraer datos del JWPlayer
      const mediaData = await session.page.evaluate(() => {
        try {
          const player = window.jwplayer();
          const config = player.getConfig?.() || {};
          const playlist = player.getPlaylist?.()?.[0] || {};

          const tracks = (playlist.tracks || config.tracks || [])
            .filter(t => t.kind === 'captions' || t.kind === 'subtitles')
            .map(t => ({ label: t.label || 'Unknown', file: t.file }));

          const file = playlist.sources?.[0]?.file || config.sources?.[0]?.file || null;

          return { file, tracks };
        } catch (e) {
          return { file: null, tracks: [] };
        }
      });

      if (!mediaData.file) {
        await session.context.close();
        sessions.delete(sessionId);
        return res.status(404).json({ error: "No se pudo resolver el stream" });
      }

      // URL del proxy que usa la sesión de Playwright
      const proxyUrl = `https://${req.get('host')}/api/stream-proxy?session=${sessionId}&url=`;

      return res.json({
        type: 'hls',
        url: proxyUrl + encodeURIComponent(mediaData.file),
        rawUrl: mediaData.file,
        tracks: mediaData.tracks,
        sessionId: sessionId,
        serverName: 'goodstream'
      });

    } else {
      // Vimeos: usar resolver normal
      const result = await resolveVimeosEmbed(null, embedUrl);
      return res.json({
        type: 'hls',
        url: result.url,
        rawUrl: result.url,
        tracks: result.tracks || [],
        serverName: 'vimeos'
      });
    }

  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROXY DE STREAM VIA PLAYWRIGHT (navegador real)
// ═══════════════════════════════════════════════════════════════
app.get("/api/stream-proxy", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  const sessionId = req.query.session;
  const targetUrl = req.query.url;

  if (!sessionId || !targetUrl) {
    return res.status(400).send("Faltan parámetros session o url");
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(410).send("Sesión expirada. Recarga el video.");
  }

  try {
    session.lastUsed = Date.now();

    // USAR LA PÁGINA DE PLAYWRIGHT PARA HACER LA PETICIÓN
    // Esto mantiene la misma sesión, cookies, fingerprint
    const response = await session.page.evaluate(async (url) => {
      const res = await fetch(url, {
        credentials: 'include', // Enviar cookies
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
      return res.status(response.status).send(`Error: ${response.status}`);
    }

    // Si es m3u8, reescribir URLs para pasar por este proxy
    if (targetUrl.includes('.m3u8') || response.contentType.includes('mpegurl')) {
      const text = Buffer.from(response.base64, 'base64').toString('utf-8');
      const hostUrl = `https://${req.get('host')}/api/stream-proxy?session=${sessionId}&url=`;
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const lines = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;

        let absoluteUrl = trimmed;
        if (!trimmed.startsWith('http')) {
          absoluteUrl = new URL(trimmed, baseUrl).href;
        }

        return `${hostUrl}${encodeURIComponent(absoluteUrl)}`;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(lines.join('\n'));
    }

    // Para segmentos .ts, devolver binario
    const buffer = Buffer.from(response.base64, 'base64');
    res.setHeader('Content-Type', response.contentType);
    res.send(buffer);

  } catch (error) {
    console.error("Stream proxy error:", error);
    return res.status(500).send(error.message);
  }
});
// Añade esto a tu servidor principal (Express/Fastify/etc)

// Endpoint proxy: recibe URL y la devuelve con headers CORS + Referer
app.get('/api/cors-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://goodstream.one/';
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Referer': referer,
        'Origin': new URL(referer).origin,
        'Accept': '*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      // Importante: no seguir redirects automáticamente para controlar todo
      redirect: 'follow',
    });

    // Copiar headers importantes
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', contentType);
    
    // Si es m3u8, procesamos para reescribir URLs relativas
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8')) {
      const text = await response.text();
      
      // Reescribir URLs relativas a absolutas y pasarlas por nuestro proxy
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const proxyBase = `${req.protocol}://${req.get('host')}/api/cors-proxy?referer=${encodeURIComponent(referer)}&url=`;
      
      const processed = text.replace(
        /^(?!#)([^\s]+)/gm,
        (match) => {
          // Si ya es absoluta
          if (match.startsWith('http')) {
            return proxyBase + encodeURIComponent(match);
          }
          // Si es relativa
          return proxyBase + encodeURIComponent(baseUrl + match);
        }
      );
      
      return res.send(processed);
    }

    // Para segmentos .ts, .m4s, etc: stream directo
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(502).json({ error: 'Proxy failed', message: err.message });
  }
});

// Preflight CORS
app.options('/api/cors-proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});
// ═══════════════════════════════════════════════════════════════
// SPA fallback
// ═══════════════════════════════════════════════════════════════
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "web-singler", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});