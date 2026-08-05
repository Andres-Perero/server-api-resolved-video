/**
 * resolvers/vimeos.js — Resuelve el .m3u8 real de un embed de vimeos.net
 * (y hosts hermanos que corren el mismo player jw8 + disable-devtool).
 *
 * IMPORTANTE: la URL del .m3u8 viene con un token firmado que EXPIRA
 * (parámetro `e=` en segundos, típicamente 43200 = 12h desde `s=`).
 * Por eso este resolver está pensado para correr CERCA del momento de
 * reproducción, no como parte del scraping masivo de catálogo.
 */

// Dominios que hay que bloquear para que el player cargue limpio:
//   - disable-devtool: vacía el DOM si detecta devtools/automatización
//   - imasdk / ima-ad-player: pre-roll de video ads (Google IMA)
//   - pop.js / xd/: popups y "exit ads" del propio vimeos.net
//   - adangle.online / xbeat.space / animehack.org: trackers/redirectores
//     de terceros detectados en el tráfico real (VAST de ads secundarios)
export const VIMEOS_BLOCKED_PATTERNS = [
  'cdn.jsdelivr.net/npm/disable-devtool',
  'imasdk.googleapis.com',
  'cdn.jsdelivr.net/npm/ima-ad-player',
  'vimeos.net/js/pop.js',
  'vimeos.net/xd/',
  'anal.vimeos.net',
  'adangle.online',
  'xbeat.space',
  'animehack.org',
  '.mp4' // bloquea el mp4 de ad (ej: 1xbet_ec_...mp4) que no es el contenido
];

/**
 * Resuelve un embed de vimeos.net y devuelve el .m3u8 real + subtítulos + audios.
 * @param {import('playwright').BrowserContext} context
 * @param {string} embedUrl - ej: https://vimeos.net/embed-xkal207cf3kx.html
 * @returns {Promise<{type:'hls', url:string, tracks:Array, audioTracks:Array, referer:string, resolvedAt:string}|null>}
 */
export async function resolveVimeosEmbed(context, embedUrl) {
  const page = await context.newPage();

  const hlsHits = [];

  // Bloqueo de red: anti-devtool, ads, trackers
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (VIMEOS_BLOCKED_PATTERNS.some((p) => url.includes(p))) {
      return route.abort();
    }
    return route.continue();
  });

  page.on('response', (res) => {
    const url = res.url();
    // Nos interesa el master.m3u8 (contiene "master" o ".urlset"), no los
    // sub-playlists individuales ni los segmentos .ts
    if (/master\.m3u8|\.urlset\/master\.m3u8/.test(url)) {
      hlsHits.push(url);
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Intenta cerrar la interstitial "¿Quieres continuar viendo?"
    const clickCandidates = ['text=Empezar desde el inicio', 'text=Continuar viendo', 'text=Resume'];
    for (const selector of clickCandidates) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // Espera a que jwplayer inicialice y arme su playlist
    await page.waitForFunction(
      () => {
        try {
          return typeof jwplayer === 'function' && jwplayer().getConfig?.();
        } catch {
          return false;
        }
      },
      { timeout: 10_000 }
    ).catch(() => {});

    // Extrae metadatos directamente del cliente JWPlayer
    const mediaData = await page.evaluate(() => {
      try {
        const player = jwplayer();
        const config = player.getConfig?.() || {};
        const playlist = player.getPlaylist?.()?.[0] || {};

        // Extrae Subtítulos buscando tanto en playlist como en la config global
        const rawTracks = playlist.tracks || config.tracks || [];
        const tracks = rawTracks
          .filter((t) => t.kind === 'captions' || t.kind === 'subtitles')
          .map((t) => ({
            label: t.label || 'Unknown',
            file: t.file
          }));

        // Extrae las pistas de Audio (si existen)
        const audioTracks = (player.getAudioTracks?.() || []).map((a) => ({
          id: a.id,
          label: a.name || a.label
        }));

        // Extrae la URL del stream principal
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

    // Extrae el Referer dinámico del host enviado
    const parsedEmbed = new URL(embedUrl);
    const refererHost = `${parsedEmbed.protocol}//${parsedEmbed.host}/`;

    return {
      type: 'hls',
      url: finalUrl,
      tracks: mediaData.tracks,
      audioTracks: mediaData.audioTracks,
      referer: refererHost,
      resolvedAt: new Date().toISOString()
    };
  } finally {
    await page.close();
  }
}