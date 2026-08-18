/**
 * Vercel API Route: /api/lulu
 * Resuelve embeds LuluVDO / LuluStream (JW packed) → master.m3u8
 *
 * GET /api/lulu?url=https://luluvdo.com/e/XXXX
 *
 * Nota: el m3u8 de tnmr.org suele ir firmado por IP.
 * Si proxyeas desde otro host (CF Worker / otro Vercel) puede dar 403.
 * Ideal: resolve + proxy en el mismo servidor (Render).
 */

function packerToString(n, base) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (n === 0) return '0';
  let out = '';
  while (n > 0) {
    out = alphabet[n % base] + out;
    n = Math.floor(n / base);
  }
  return out;
}

function unpackPacker(source) {
  const mm = source.match(
    /\}\('(.*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*)'\.split\('\|'\)\)\)/s
  );
  if (!mm) throw new Error('No packer payload');
  let p = mm[1];
  const a = parseInt(mm[2], 10);
  const c = parseInt(mm[3], 10);
  const k = mm[4].split('|');
  for (let i = c - 1; i >= 0; i--) {
    if (k[i]) {
      p = p.replace(new RegExp('\\b' + packerToString(i, a) + '\\b', 'g'), k[i]);
    }
  }
  return p;
}

function isLuluUrl(url) {
  try {
    const u = new URL(url);
    return (
      /lulu/i.test(u.hostname) ||
      u.pathname.includes('/e/')
    );
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ success: false, error: 'Falta ?url=' });
  }

  if (!isLuluUrl(url) && !String(url).includes('/e/')) {
    return res.status(400).json({ success: false, error: 'URL Lulu inválida' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://luluvdo.com/',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: 'HTTP ' + response.status + ' al cargar embed',
      });
    }

    const html = await response.text();
    const start = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (start < 0) {
      return res.status(404).json({
        success: false,
        error: 'No se encontró script packed de JW',
      });
    }
    const end = html.indexOf(".split('|')))", start);
    if (end < 0) {
      return res.status(404).json({ success: false, error: 'Packer incompleto' });
    }

    const unpacked = unpackPacker(
      html.slice(start, end + ".split('|')))".length)
    );

    let m = unpacked.match(/file:"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (!m) m = unpacked.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
    if (!m) {
      return res.status(404).json({
        success: false,
        error: 'm3u8 no encontrado en jwplayer.setup',
      });
    }

    const streamUrl = m[1];
    const titleM = html.match(/<title>([^<]+)/i);
    const thumbM = html.match(/og:image"\s+content="([^"]+)"/i);
    const codeM = String(url).match(/\/e\/([a-z0-9]+)/i);

    return res.status(200).json({
      success: true,
      url: streamUrl,
      type: 'hls',
      title: titleM
        ? titleM[1].replace(/\s+/g, ' ').trim()
        : null,
      thumbnail: thumbM ? thumbM[1] : null,
      file_code: codeM ? codeM[1] : null,
      source: 'lulu-packer',
      page: response.url || url,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno',
    });
  }
}
