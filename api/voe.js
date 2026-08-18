/**
 * Vercel API Route: /api/voe
 * Resuelve embeds de VOE.sx (y dominios espejo) → master.m3u8
 *
 * GET /api/voe?url=https://voe.sx/e/XXXX
 * GET /api/voe?url=https://rebeccapracticeloss.com/e/XXXX
 */

import { Buffer } from 'buffer';

const VOE_DOMAINS = [
  'voe.sx',
  'rebeccapracticeloss.com',
  // dominios espejo comunes de VOE (se actualizan con frecuencia)
];

function isVoeUrl(url) {
  try {
    const u = new URL(url);
    return (
      VOE_DOMAINS.some((d) => u.hostname.includes(d)) ||
      u.pathname.includes('/e/')
    );
  } catch {
    return false;
  }
}

/**
 * Algoritmo de decode de VOE (payload application/json + LUTs del loader)
 * Basado en extractores públicos actuales (mediaflow-proxy, etc.)
 */
function voeDecode(ct, luts) {
  // 1) Shift de letras
  let txt = '';
  for (const ch of ct) {
    let x = ch.charCodeAt(0);
    if (x > 64 && x < 91) {
      // A-Z
      x = ((x - 52) % 26) + 65;
    } else if (x > 96 && x < 123) {
      // a-z
      x = ((x - 84) % 26) + 97;
    }
    txt += String.fromCharCode(x);
  }

  // 2) Quitar patrones LUT
  for (const lut of luts) {
    txt = txt.split(lut).join('');
  }

  // 3) Base64
  const pad = '='.repeat((4 - (txt.length % 4)) % 4);
  let ct2 = Buffer.from(txt + pad, 'base64').toString('utf8');

  // 4) Shift -3
  let txt2 = '';
  for (const ch of ct2) {
    txt2 += String.fromCharCode(ch.charCodeAt(0) - 3);
  }

  // 5) Reverse + Base64
  const reversed = txt2.split('').reverse().join('');
  const pad2 = '='.repeat((4 - (reversed.length % 4)) % 4);
  const final = Buffer.from(reversed + pad2, 'base64').toString('utf8');

  return JSON.parse(final);
}

const DEFAULT_LUTS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Falta ?url=' });
  }

  // Normalizar voe.sx → a veces redirige; intentamos el dominio que nos den
  try {
    // Si es voe.sx puro, probar también seguir redirect manualmente
    const tryUrls = [url];
    if (url.includes('voe.sx')) {
      // Algunos mirrors conocidos / patrón /e/ID
      const idMatch = url.match(/\/e\/([a-z0-9]+)/i);
      if (idMatch) {
        tryUrls.push(`https://rebeccapracticeloss.com/e/${idMatch[1]}`);
      }
    }

    let html = null;
    let finalPageUrl = url;

    for (const tryUrl of tryUrls) {
      try {
        const r = await fetch(tryUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://voe.sx/',
          },
          redirect: 'follow',
        });

        if (r.ok) {
          html = await r.text();
          finalPageUrl = r.url || tryUrl;
          // Si es página de challenge/403 corta, seguir probando
          if (html.length > 5000 && !html.includes('Just a moment')) break;
        }
      } catch (_) {}
    }

    if (!html || html.length < 1000) {
      return res.status(502).json({
        success: false,
        error: 'No se pudo cargar la página de VOE (posible DDoS-Guard o dominio caído)',
      });
    }

    // Extraer payload application/json
    let ctMatch = html.match(
      /<script[^>]*type=["']application\/json["'][^>]*>\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/is
    );
    if (!ctMatch) {
      ctMatch = html.match(/json">\["([^"]+)"]<\/script>/i);
    }

    if (!ctMatch) {
      return res.status(404).json({
        success: false,
        error: 'No se encontró el payload ofuscado de VOE',
      });
    }

    const ct = ctMatch[1];

    // Intentar sacar LUTs del loader (si está inline o referenciado)
    let luts = DEFAULT_LUTS;
    const lutMatch = html.match(/\[(?:'[^']{1,4}'[,\]]){3,}/);
    // Si hay un array de strings cortos típicos, usarlo
    // Por defecto usamos los conocidos que funcionan hoy

    let data;
    try {
      data = voeDecode(ct, luts);
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: 'Error decodificando payload VOE: ' + e.message,
      });
    }

    const streamUrl = data.source || data.direct_access_url;
    if (!streamUrl) {
      return res.status(404).json({
        success: false,
        error: 'Payload decodificado pero sin URL de video',
        keys: Object.keys(data),
      });
    }

    return res.status(200).json({
      success: true,
      url: streamUrl,
      type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
      title: data.title || null,
      thumbnail: data.thumbnail || null,
      file_code: data.file_code || null,
      source: 'voe-decoded',
      page: finalPageUrl,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno',
    });
  }
}
