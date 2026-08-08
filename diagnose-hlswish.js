/**
 * diagnose-hlswish.js — Diagnóstico para embeds de HLSWish / StreamHG
 *
 * Uso:
 *   node diagnose-hlswish.js [url]
 *   node diagnose-hlswish.js https://hlswish.com/e/pjqb4uzo5bwy
 *
 * Extrae: master m3u8 (hls2/hls3/hls4), subtítulos VTT y pistas de audio del HLS.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetUrl = process.argv[2] || 'https://hlswish.com/e/pjqb4uzo5bwy';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Desempaqueta el packer eval(function(p,a,c,k,e,d){...}) típico de hlswish/streamhg */
function unpackPacker(html) {
  const m = html.match(
    /eval\(function\(p,a,c,k,e,d\)\{while\(c--\)if\(k\[c\]\)p=p\.replace\(new RegExp\('\\\\b'\+c\.toString\(a\)\+'\\\\b','g'\),k\[c\]\);return p\}\('((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/
  );
  if (!m) return null;

  const p = m[1];
  const a = parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const k = m[4].split('|');

  function toBase(n, base) {
    if (n === 0) return '0';
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
    let s = '';
    while (n) {
      s = digits[n % base] + s;
      n = Math.floor(n / base);
    }
    return s;
  }

  let result = p;
  for (let i = c - 1; i >= 0; i--) {
    if (i < k.length && k[i]) {
      const token = toBase(i, a);
      result = result.replace(new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), k[i]);
    }
  }
  return result;
}

/** Extrae links + tracks del JS desempaquetado */
function extractFromUnpacked(js, pageOrigin) {
  const out = {
    links: {},
    tracks: [],
    duration: null,
    image: null,
    qualityLabels: null,
  };

  const linksMatch = js.match(/links\s*=\s*\{([^}]+)\}/);
  if (linksMatch) {
    const body = linksMatch[1];
    for (const key of ['hls2', 'hls3', 'hls4']) {
      const km = body.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (km) {
        let url = km[1];
        if (url.startsWith('/')) url = pageOrigin + url;
        out.links[key] = url;
      }
    }
  }

  // tracks array (puede tener varios objetos)
  const tracksBlock = js.match(/tracks\s*:\s*\[([^\]]+)\]/);
  if (tracksBlock) {
    const re = /\{\s*file\s*:\s*"([^"]+)"\s*,\s*label\s*:\s*"([^"]+)"\s*,\s*kind\s*:\s*"([^"]+)"(?:\s*,\s*"?default"?\s*:\s*(true))?/g;
    let tm;
    while ((tm = re.exec(tracksBlock[1])) !== null) {
      out.tracks.push({
        file: tm[1],
        label: tm[2],
        kind: tm[3],
        default: !!tm[4],
      });
    }
    // thumbnails sin label
    const thumb = tracksBlock[1].match(/file\s*:\s*"([^"]+)"\s*,\s*kind\s*:\s*"thumbnails"/);
    if (thumb) {
      out.tracks.push({ file: thumb[1], kind: 'thumbnails' });
    }
  }

  const dur = js.match(/duration\s*:\s*"?([\d.]+)"?/);
  if (dur) out.duration = parseFloat(dur[1]);

  const img = js.match(/image\s*:\s*"([^"]+)"/);
  if (img) out.image = img[1];

  const ql = js.match(/qualityLabels\s*:\s*(\{[^}]+\})/);
  if (ql) {
    try {
      out.qualityLabels = JSON.parse(ql[1].replace(/(\w+)\s*:/g, '"$1":'));
    } catch {
      out.qualityLabels = ql[1];
    }
  }

  return out;
}

/** Fallback regex sobre HTML crudo (por si no hay packer) */
function extractRawRegex(html, pageOrigin) {
  const out = { m3u8: [], vtt: [] };
  const m3u8 = [...html.matchAll(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/gi)];
  m3u8.forEach((m) => out.m3u8.push(m[1]));
  const rel = [...html.matchAll(/["'](\/stream\/[^"']+\.m3u8)["']/gi)];
  rel.forEach((m) => out.m3u8.push(pageOrigin + m[1]));
  const vtt = [...html.matchAll(/(https?:\/\/[^"'\s]+\.vtt)/gi)];
  vtt.forEach((m) => out.vtt.push(m[1]));
  return out;
}

async function fetchMasterAudioTracks(m3u8Url) {
  try {
    const res = await fetch(m3u8Url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
        Referer: targetUrl,
      },
    });
    if (!res.ok) return { status: res.status, audio: [], levels: [] };
    const text = await res.text();
    const audio = [];
    const levels = [];
    for (const line of text.split('\n')) {
      if (line.includes('TYPE=AUDIO')) {
        const name = line.match(/NAME="([^"]+)"/)?.[1];
        const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1];
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        const def = /DEFAULT=YES/i.test(line);
        audio.push({ name, language: lang, uri, default: def });
      }
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
        const bw = line.match(/BANDWIDTH=(\d+)/);
        levels.push({
          resolution: resMatch?.[1],
          bandwidth: bw ? parseInt(bw[1], 10) : null,
        });
      }
    }
    return { status: 200, audio, levels, preview: text.slice(0, 400) };
  } catch (e) {
    return { status: 'error', error: e.message, audio: [], levels: [] };
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  log(`Analizando: ${targetUrl}`);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const html = await page.content();
  const pageOrigin = new URL(targetUrl).origin;

  // 1) Desempaquetar packer
  const unpacked = unpackPacker(html);
  log(`[Packer] ${unpacked ? 'desempaquetado OK (' + unpacked.length + ' chars)' : 'no encontrado'}`);

  let extracted = null;
  if (unpacked) {
    extracted = extractFromUnpacked(unpacked, pageOrigin);
    log(`[Links] ${JSON.stringify(extracted.links, null, 2)}`);
    log(`[Tracks] ${extracted.tracks.length} pistas`);
    extracted.tracks.forEach((t) =>
      log(`  ↳ [${t.kind}] ${t.label || ''} ${t.file?.slice(0, 90) || ''}`)
    );
  }

  // 2) Regex crudo de respaldo
  const raw = extractRawRegex(html, pageOrigin);
  log(`[Regex] m3u8 crudos: ${raw.m3u8.length}, vtt: ${raw.vtt.length}`);

  // 3) JWPlayer API si está disponible
  const jwInfo = await page.evaluate(() => {
    if (typeof jwplayer !== 'function') return { status: 'jwplayer no definido' };
    try {
      const player = jwplayer('vplayer') || jwplayer();
      if (!player || !player.getConfig) return { status: 'instancia no hallada' };
      return {
        playlist: player.getPlaylist?.(),
        config: {
          file: player.getConfig?.()?.file,
          sources: player.getConfig?.()?.sources,
          duration: player.getDuration?.(),
        },
        captions: player.getCaptionsList?.(),
        audioTracks: player.getAudioTracks?.(),
      };
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  });
  log(`[JWPlayer API]: ${JSON.stringify(jwInfo, null, 2).slice(0, 800)}`);

  // 4) Probar master m3u8 y listar audios/niveles
  const candidates = [];
  if (extracted?.links) {
    for (const k of ['hls4', 'hls2', 'hls3']) {
      if (extracted.links[k]) candidates.push({ key: k, url: extracted.links[k] });
    }
  }
  raw.m3u8.forEach((u) => {
    if (!candidates.some((c) => c.url === u)) candidates.push({ key: 'regex', url: u });
  });

  const masterProbe = [];
  for (const c of candidates.slice(0, 3)) {
    log(`Probando master [${c.key}]: ${c.url.slice(0, 100)}...`);
    const probe = await fetchMasterAudioTracks(c.url);
    log(`  → status=${probe.status} audio=${probe.audio?.length || 0} levels=${probe.levels?.length || 0}`);
    if (probe.audio?.length) {
      probe.audio.forEach((a) =>
        log(`    🔊 ${a.name || a.language} default=${a.default} uri=${a.uri || 'inline'}`)
      );
    }
    masterProbe.push({ ...c, probe });
  }

  const report = {
    targetUrl,
    pageOrigin,
    extracted,
    rawRegex: raw,
    jwInfo,
    masterProbe,
    primaryM3u8:
      extracted?.links?.hls4 ||
      extracted?.links?.hls2 ||
      extracted?.links?.hls3 ||
      raw.m3u8[0] ||
      null,
    subtitles: (extracted?.tracks || []).filter((t) => t.kind === 'captions'),
  };

  const outPath = join(__dirname, 'hlswish-report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  log(`Reporte guardado: ${outPath}`);
  log(`Primary M3U8: ${report.primaryM3u8}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});