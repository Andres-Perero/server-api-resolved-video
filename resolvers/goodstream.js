/**
 * resolvers/goodstream.js — Resuelve el .m3u8 real de embeds de goodstream.one
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
  '.mp4'
];

export async function resolveGoodstreamEmbed(context, embedUrl) {
  const page = await context.newPage();

  const hlsHits = [];

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (GOODSTREAM_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  page.on('response', (res) => {
    const url = res.url();
    if (/\.m3u8/.test(url)) {
      hlsHits.push(url);
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Esperar a la inicialización de JWPlayer
    await page.waitForFunction(
      () => typeof window.jwplayer === 'function' && window.jwplayer().getConfig?.(),
      { timeout: 8_000 }
    ).catch(() => {});

    // Extraer metadata del JWPlayer (Fuentes, Subtítulos y Audios)
    const mediaData = await page.evaluate(() => {
      try {
        const player = window.jwplayer();
        const config = player.getConfig?.() || {};
        const playlist = player.getPlaylist?.()?.[0] || {};

        // Extract Subtitles/Captions
        const tracksRaw = playlist.tracks || config.tracks || [];
        const tracks = tracksRaw
          .filter((t) => t.kind === 'captions' || t.kind === 'subtitles')
          .map((t) => ({
            label: t.label || 'Unknown',
            file: t.file
          }));

        // Extract Audio Tracks
        const audioTracks = (player.getAudioTracks?.() || []).map((a) => ({
          id: a.id,
          label: a.name || a.label
        }));

        // Extract Direct File
        const file = playlist.sources?.[0]?.file || config.sources?.[0]?.file || null;

        return { file, tracks, audioTracks };
      } catch {
        return { file: null, tracks: [], audioTracks: [] };
      }
    }).catch(() => ({ file: null, tracks: [], audioTracks: [] }));

    const finalUrl = mediaData.file || hlsHits[0] || null;

    if (!finalUrl) {
      return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // EXTRAER COOKIES DEL CONTEXTO DE PLAYWRIGHT
    // ═══════════════════════════════════════════════════════════════
    const allCookies = await context.cookies();
    const goodstreamCookies = allCookies
      .filter(c => {
        // Filtrar cookies relevantes para goodstream y sus CDNs
        const domain = c.domain.toLowerCase();
        return domain.includes('goodstream') || 
               domain.includes('enc') ||
               domain.includes('s1.') ||
               domain.includes('s2.') ||
               domain.includes('s3.');
      })
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    console.log('Cookies capturadas:', goodstreamCookies.substring(0, 200) + '...');

    const parsedEmbed = new URL(embedUrl);
    const refererHost = `${parsedEmbed.protocol}//${parsedEmbed.host}/`;

    return {
      type: 'hls',
      url: finalUrl,
      tracks: mediaData.tracks,
      audioTracks: mediaData.audioTracks,
      cookies: goodstreamCookies,  // ← PASAR COOKIES
      referer: refererHost,
      resolvedAt: new Date().toISOString()
    };
  } finally {
    await page.close();
  }
}