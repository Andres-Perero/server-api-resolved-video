/**
 * resolvers/goodstream.js — Resuelve .m3u8, subtítulos y metadata de goodstream.one
 */

export const GOODSTREAM_BLOCKED_PATTERNS = [
  'cdn.jsdelivr.net/npm/disable-devtool',
  'imasdk.googleapis.com',
  'cdn.jsdelivr.net/npm/ima-ad-player',
  'pop.js',
  'anal.',
  'adangle.online',
  'xbeat.space',
  'animehack.org',
  'rocket-loader.min.js' // Opcional: bloquea la demora de Rocket Loader si solo se extrae inline
];

export async function resolveGoodstreamEmbed(context, embedUrl) {
  const page = await context.newPage();
  const networkHits = {
    m3u8: [],
    vtt: []
  };

  // Interceptar bloqueos y capturar red por respaldo
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (GOODSTREAM_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  page.on('response', (res) => {
    const url = res.url();
    if (/\.m3u8/i.test(url)) networkHits.m3u8.push(url);
    if (/\.vtt|\.srt/i.test(url)) networkHits.vtt.push(url);
  });

  try {
    const response = await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
    const html = await page.content().catch(() => '');

    // -------------------------------------------------------------
    // ESTRATEGIA 1: Extracción Directa vía Regex (Fast & Anti-RocketLoader)
    // -------------------------------------------------------------
    let directFile = null;
    const directTracks = [];

    // Extraer file .m3u8 del script setup inline
    const m3u8Match = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (m3u8Match) {
      directFile = m3u8Match[1];
    }

    // Extraer tracks (.vtt) inline
    const tracksMatch = html.match(/tracks\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
    if (tracksMatch) {
      try {
        // Limpieza básica de la estructura JS a JSON válido
        const cleanedTracksJson = tracksMatch[1]
          .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/'/g, '"');
        
        const rawTracks = JSON.parse(cleanedTracksJson);
        rawTracks.forEach((t) => {
          if (t.kind === 'captions' || t.kind === 'subtitles') {
            directTracks.push({
              label: t.label || 'Unknown',
              file: t.file
            });
          }
        });
      } catch {
        // Regex de respaldo para capturar URLs de .vtt manualmente
        const vttRegex = /file\s*:\s*["']([^"']+\.vtt)["'](?:\s*,\s*label\s*:\s*["']([^"']+)["'])?/gi;
        let match;
        while ((match = vttRegex.exec(html)) !== null) {
          if (!match[1].includes('_sli.vtt')) { // Ignorar miniaturas
            directTracks.push({
              label: match[2] || 'Subtitle',
              file: match[1]
            });
          }
        }
      }
    }

    // -------------------------------------------------------------
    // ESTRATEGIA 2: Evaluación runtime de JWPlayer (Respaldo)
    // -------------------------------------------------------------
    let mediaData = { file: directFile, tracks: directTracks, audioTracks: [] };

    if (!mediaData.file) {
      // Esperar a que jwplayer esté listo Y tenga una fuente cargada
await page.waitForFunction(() => {
    const p = jwplayer('vplayer');
    return p && p.getConfig && p.getPlaylist()?.[0]?.sources?.[0]?.file;
}, { timeout: 15000 });

const file = await page.evaluate(() => 
    jwplayer('vplayer').getPlaylist()[0].sources[0].file
);

      const runtimeData = await page.evaluate(() => {
        try {
          const player = typeof jwplayer === 'function' ? jwplayer('vplayer') : null;
          if (!player || !player.getConfig) return null;

          const playlist = player.getPlaylist?.()?.[0] || {};
          const config = player.getConfig() || {};

          const file = playlist.sources?.[0]?.file || config.sources?.[0]?.file || null;
          const tracks = (playlist.tracks || config.tracks || [])
            .filter((t) => t.kind === 'captions' || t.kind === 'subtitles')
            .map((t) => ({ label: t.label || 'Unknown', file: t.file }));

          const audioTracks = (player.getAudioTracks?.() || []).map((a) => ({
            id: a.id,
            label: a.name || a.label
          }));

          return { file, tracks, audioTracks };
        } catch {
          return null;
        }
      }).catch(() => null);

      if (runtimeData) {
        mediaData = {
          file: runtimeData.file || mediaData.file,
          tracks: runtimeData.tracks.length ? runtimeData.tracks : mediaData.tracks,
          audioTracks: runtimeData.audioTracks
        };
      }
    }

    const finalUrl = mediaData.file || networkHits.m3u8[0] || null;

    if (!finalUrl) {
      return null;
    }

    // Captura de cookies y cabeceras
    const allCookies = await context.cookies();
    const goodstreamCookies = allCookies
      .filter((c) => {
        const domain = c.domain.toLowerCase();
        return (
          domain.includes('goodstream') ||
          domain.includes('enc') ||
          domain.includes('s1.') ||
          domain.includes('s2.')
        );
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const parsedEmbed = new URL(embedUrl);

    return {
      type: 'hls',
      url: finalUrl,
      tracks: mediaData.tracks,
      audioTracks: mediaData.audioTracks,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
        'Referer': `${parsedEmbed.protocol}//${parsedEmbed.host}/`,
        'Origin': `${parsedEmbed.protocol}//${parsedEmbed.host}`,
        'Cookie': goodstreamCookies
      },
      resolvedAt: new Date().toISOString()
    };
  } finally {
    await page.close();
  }
}