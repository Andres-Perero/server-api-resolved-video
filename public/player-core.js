// ═══════════════════════════════════════════════════════════════
// PLAYER-CORE.JS — Frontend Multi-Servidor:
// Vimeos: resolución via API Playwright (Render) → URL directa
// GoodStream: resolución via Worker Cloudflare
// HLSWish: resolución via desempaquetado de packer JS (fetch directo)
// Directo: reproduce M3U8 directamente
// ═══════════════════════════════════════════════════════════════

// ─── CONFIGURACIÓN ──────────────────────────────────────────
// API de Playwright en Render (SOLO para resolución, NO para proxy)
const VIMEOS_RESOLVER_API = 'https://server-api-resolved-video.onrender.com/api/resolve';

// Worker de GoodStream (sirve como proxy CORS para Vimeos, GoodStream y HLSWish M3U8/segmentos)
const GOODSTREAM_WORKER = 'https://goodstream-proxy-render.ff15.workers.dev/?url=';

// ─── ESTADO GLOBAL ───────────────────────────────────────────
const capturedManifests = new Set();
let currentSource = null;
let hls = null;

/** Corrige https:/host → https://host (típico en ?embed= mal escrito) */
function normalizeEmbedUrl(url) {
  if (!url) return url;
  url = String(url).trim();
  url = url.replace(/^https:\/(?!\/)/i, 'https://');
  url = url.replace(/^http:\/(?!\/)/i, 'http://');
  return url;
}

// ─── DETECTAR SERVIDOR ──────────────────────────────────────
function detectServer(url) {
  if (!url) return null;
  if (url.includes('goodstream')) return 'goodstream';
  if (url.includes('vimeos')) return 'vimeos';
  if (url.includes('hlswish') || url.includes('streamhg') || url.includes('streamwish')) return 'hlswish';
  return null;
}

// ─── CAPTURA DE M3U8 ───────────────────────────────────────
function reportManifest(url, kind = 'hls', title = '') {
  if (!url || capturedManifests.has(url)) return;
  capturedManifests.add(url);

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({
      type: 'VIDEO_FOUND',
      url: url,
      kind: kind,
      title: title || VIDEO_TITLE || document.title,
      contentType: 'application/vnd.apple.mpegurl'
    }).catch(() => {});
  }

  console.log('[M3U8 CAPTURADO]', url);

  try {
    const stored = JSON.parse(localStorage.getItem('captured_m3u8') || '[]');
    stored.push({ url, title: title || VIDEO_TITLE, timestamp: Date.now() });
    localStorage.setItem('captured_m3u8', JSON.stringify(stored.slice(-20)));
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// DESMPAQUETADO DE PACKER JS (HLSWish)
// ═══════════════════════════════════════════════════════════════

function unpackPacker(html) {
  // Variantes del packer Dean Edwards / similar embebido en hlswish
  const patterns = [
    // \\b escapado doble (como aparece en el HTML fuente)
    /eval\(function\(p,a,c,k,e,d\)\{while\(c--\)if\(k\[c\]\)p=p\.replace\(new RegExp\('\\\\b'\+c\.toString\(a\)\+'\\\\b','g'\),k\[c\]\);return p\}\('((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/,
    // \b simple
    /eval\(function\(p,a,c,k,e,d\)\{while\(c--\)if\(k\[c\]\)p=p\.replace\(new RegExp\('\\b'\+c\.toString\(a\)\+'\\b','g'\),k\[c\]\);return p\}\('((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/,
    // flexible: cualquier cuerpo entre { y }('payload'
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/,
  ];

  let m = null;
  for (let i = 0; i < patterns.length; i++) {
    m = html.match(patterns[i]);
    if (m) {
      console.log('[HLSWish] Packer match variante', i + 1);
      break;
    }
  }
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
      result = result.replace(
        new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'),
        k[i]
      );
    }
  }
  return result;
}
function extractHLSWishMedia(html, pageOrigin) {
  const result = { links: {}, captions: [], image: null, duration: null };

  const unpacked = unpackPacker(html);
  if (!unpacked) {
    console.warn('[HLSWish] Packer NO encontrado en HTML (' + html.length + ' chars)');
  }
  if (unpacked) {
    console.log('[HLSWish] Packer desempaquetado (' + unpacked.length + ' chars)');

    const linksMatch = unpacked.match(/links\s*=\s*\{([^}]+)\}/);
    if (linksMatch) {
      ['hls2', 'hls3', 'hls4'].forEach(function (key) {
        const km = linksMatch[1].match(new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"'));
        if (km) {
          let u = km[1];
          if (u.startsWith('/')) u = pageOrigin + u;
          result.links[key] = u;
        }
      });
    }

    const tracksBlock = unpacked.match(/tracks\s*:\s*\[([^\]]+)\]/);
    if (tracksBlock) {
      const re = /\{\s*file\s*:\s*"([^"]+)"\s*,\s*label\s*:\s*"([^"]+)"\s*,\s*kind\s*:\s*"([^"]+)"(?:\s*,\s*"?default"?\s*:\s*(true))?/g;
      let tm;
      while ((tm = re.exec(tracksBlock[1])) !== null) {
        if (tm[3] === 'captions') {
          result.captions.push({
            file: tm[1],
            label: tm[2],
            default: !!tm[4],
          });
        }
      }
    }

    const img = unpacked.match(/image\s*:\s*"([^"]+)"/);
    if (img) result.image = img[1];
    const dur = unpacked.match(/duration\s*:\s*"?([\d.]+)"?/);
    if (dur) result.duration = parseFloat(dur[1]);
  }

  // Fallback regex
  if (!result.links.hls2 && !result.links.hls4) {
    const gen = html.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (gen) result.links.regex = gen[1];
    const rel = html.match(/["'](\/stream\/[^"']+\.m3u8)["']/i);
    if (rel) result.links.hls4 = pageOrigin + rel[1];
  }
  if (!result.captions.length) {
    const vtts = [...html.matchAll(/(https?:\/\/[^"'\s]+\.vtt)/gi)];
    vtts.forEach(function (m, i) {
      result.captions.push({ file: m[1], label: 'Sub ' + (i + 1), default: i === 0 });
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// RESOLUCIÓN HLSWish — método del navegador (igual que hlswish-player.html)
// 1) Fetch HTML del embed vía Worker (CORS)
// 2) Desempaquetar packer eval(p,a,c,k)
// 3) Extraer hls2 / hls3 / hls4 + VTT
// 4) Reproducir m3u8 vía Worker (el Worker reescribe segmentos/audio)
// Fallback opcional: API Playwright si el packer falla
// ═══════════════════════════════════════════════════════════════

async function resolveHLSWishBrowser(embedUrl) {
  showLoading('Resolviendo HLSWish...');
  updateLoadingSubtext('Desempaquetando embed...');

  embedUrl = normalizeEmbedUrl(embedUrl);
  console.log('[HLSWish] Embed normalizado:', embedUrl);

  const workerUrl = GOODSTREAM_WORKER + encodeURIComponent(embedUrl);
  console.log('[HLSWish] Worker embed:', workerUrl);

  const res = await fetch(workerUrl);
  if (!res.ok) throw new Error('Worker HTTP ' + res.status + ' al cargar embed');

  const html = await res.text();
  console.log('[HLSWish] HTML recibido:', html.length, 'chars');

  const pageOrigin = new URL(embedUrl).origin;
  const media = extractHLSWishMedia(html, pageOrigin);
  console.log('[HLSWish] Links hallados:', Object.keys(media.links), media.links);

  // Preferir hls2 (CDN firmado, audio+video); hls4 como respaldo
  const order = ['hls2', 'hls4', 'hls3', 'regex'];
  const candidates = [];
  for (const key of order) {
    if (media.links[key]) candidates.push({ key, url: media.links[key] });
  }

  if (!candidates.length) {
    console.error('[HLSWish] HTML preview:', html.substring(0, 800));
    throw new Error('No se encontró .m3u8 en el embed de HLSWish');
  }

  candidates.forEach((c) => {
    console.log('[HLSWish] Candidato [' + c.key + ']:', c.url.substring(0, 100) + '...');
  });

  // Master principal
  let m3u8Url = candidates[0].url;
  if (m3u8Url.startsWith('//')) m3u8Url = 'https:' + m3u8Url;
  else if (m3u8Url.startsWith('/')) m3u8Url = pageOrigin + m3u8Url;

  console.log('[HLSWish] Usando [' + candidates[0].key + ']:', m3u8Url.substring(0, 100) + '...');
  console.log('[HLSWish] Subtítulos:', media.captions.length);
  if (media.duration) console.log('[HLSWish] Duración:', media.duration + 's');

  // Proxy de subtítulos VTT
  const tracks = (media.captions || []).map((t) => {
    let file = t.file;
    if (file.startsWith('//')) file = 'https:' + file;
    else if (file.startsWith('/')) file = pageOrigin + file;
    return {
      label: t.label || 'Unknown',
      file: GOODSTREAM_WORKER + encodeURIComponent(file),
      lang: /eng|en/i.test(t.label || '') ? 'en' : 'es',
      kind: 'captions',
      default: !!t.default,
    };
  });

  return {
    title: typeof VIDEO_TITLE !== 'undefined' ? VIDEO_TITLE : 'HLSWish',
    type: 'hls',
    url: m3u8Url,
    rawUrl: m3u8Url,
    proxyUrl: GOODSTREAM_WORKER + encodeURIComponent(m3u8Url),
    candidates: candidates.map((c) => c.url), // para fallback en loadSource si hace falta
    tracks,
    audioTracks: [], // vienen dentro del HLS
    serverName: 'hlswish',
    referer: embedUrl,
    origin: pageOrigin,
    useWorkerProxy: true,
    workerUrl: GOODSTREAM_WORKER,
    poster: media.image || null,
    duration: media.duration || null,
  };
}

/** Fallback: API Playwright en Render (mismo endpoint que Vimeos) */
async function resolveHLSWishApi(embedUrl) {
  showLoading('Resolviendo HLSWish (API)...');
  updateLoadingSubtext('Despertando servidor...');

  try {
    await fetch('https://server-api-resolved-video.onrender.com/health', {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
    });
  } catch (e) {
    console.log('[HLSWish] Render despertando...');
  }

  updateLoadingSubtext('Conectando con servidor de resolución...');

  const apiUrl = VIMEOS_RESOLVER_API + '?url=' + encodeURIComponent(embedUrl);
  console.log('[HLSWish] API Playwright:', apiUrl);

  const res = await fetch(apiUrl, {
    method: 'GET',
    mode: 'cors',
    cache: 'no-cache',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
    throw new Error(err.error || 'HTTP ' + res.status);
  }

  const data = await res.json();
  console.log('[HLSWish] API response:', data);

  if (!data.url) throw new Error('La API no devolvió URL del stream');

  const directUrl = data.url;
  const proxiedTracks = (data.tracks || []).map((t) => ({
    ...t,
    file: GOODSTREAM_WORKER + encodeURIComponent(t.file),
  }));

  return {
    title: typeof VIDEO_TITLE !== 'undefined' ? VIDEO_TITLE : 'HLSWish',
    type: 'hls',
    url: directUrl,
    rawUrl: directUrl,
    proxyUrl: GOODSTREAM_WORKER + encodeURIComponent(directUrl),
    tracks: proxiedTracks,
    audioTracks: data.audioTracks || [],
    serverName: 'hlswish',
    referer: data.referer || embedUrl,
    origin: null,
    useWorkerProxy: true,
    workerUrl: GOODSTREAM_WORKER,
    poster: data.poster || null,
  };
}

/**
 * Resolución HLSWish: primero método del HTML (navegador + packer),
 * si falla prueba la API Playwright.
 */
async function resolveHLSWish(embedUrl) {
  try {
    return await resolveHLSWishBrowser(embedUrl);
  } catch (err) {
    console.warn('[HLSWish] Método navegador falló:', err.message, '→ intentando API...');
    updateLoadingSubtext('Fallback a API...');
    try {
      return await resolveHLSWishApi(embedUrl);
    } catch (err2) {
      console.error('[HLSWish] API también falló:', err2);
      throw new Error('HLSWish: ' + err.message + ' | API: ' + err2.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// RESOLUCIÓN VIMEOS — via API Playwright (Render)
// ═══════════════════════════════════════════════════════════════

async function resolveVimeos(embedUrl) {
  showLoading('Resolviendo Vimeos...');
  updateLoadingSubtext('Despertando servidor...');

  // Wake up Render (puede tardar 30-60s si está dormido)
  try {
    await fetch('https://server-api-resolved-video.onrender.com/health', { 
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache'
    });
  } catch (e) {
    console.log('[Vimeos] Render despertando...');
  }

  updateLoadingSubtext('Conectando con servidor de resolución...');

  try {
    const apiUrl = VIMEOS_RESOLVER_API + '?url=' + encodeURIComponent(embedUrl);
    console.log('[Vimeos] Llamando API Playwright:', apiUrl);

    const res = await fetch(apiUrl, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      throw new Error(err.error || 'HTTP ' + res.status);
    }

    const data = await res.json();
    console.log('[Vimeos] API response:', data);

    if (!data.url) {
      throw new Error('La API no devolvió URL del stream');
    }

    const directUrl = data.url;
    const proxiedUrl = GOODSTREAM_WORKER + encodeURIComponent(directUrl);

    const proxiedTracks = (data.tracks || []).map(t => ({
      ...t,
      file: GOODSTREAM_WORKER + encodeURIComponent(t.file)
    }));

    return {
      title: VIDEO_TITLE,
      type: 'hls',
      url: directUrl,
      rawUrl: directUrl,
      proxyUrl: proxiedUrl,
      tracks: proxiedTracks,
      audioTracks: data.audioTracks || [],
      serverName: 'vimeos',
      referer: data.referer,
      origin: null,
      useWorkerProxy: true,
      workerUrl: GOODSTREAM_WORKER
    };

  } catch (err) {
    console.error('[Vimeos] Error:', err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// RESOLUCIÓN GOODSTREAM — via Worker Cloudflare
// ═══════════════════════════════════════════════════════════════

async function resolveGoodStream(embedUrl) {
  showLoading('Resolviendo GoodStream...');
  updateLoadingSubtext('Usando proxy seguro...');

  try {
    const workerUrl = GOODSTREAM_WORKER + encodeURIComponent(embedUrl);
    console.log('[GoodStream] Worker:', workerUrl);

    const res = await fetch(workerUrl);
    if (!res.ok) throw new Error('Worker HTTP ' + res.status);

    const html = await res.text();
    console.log('[GoodStream] HTML recibido:', html.length, 'chars');

    let m3u8Url = null;
    const patterns = [
      /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+\.m3u8[^"']*)["'][^}]*\}/i,
      /var\s+(?:source|src|url|file)\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        m3u8Url = match[1].trim();
        break;
      }
    }

    if (!m3u8Url) {
      const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
      if (scripts) {
        for (const script of scripts) {
          for (const pattern of patterns) {
            const match = script.match(pattern);
            if (match && match[1]) {
              m3u8Url = match[1].trim();
              break;
            }
          }
          if (m3u8Url) break;
        }
      }
    }

    if (!m3u8Url) {
      console.error('[GoodStream] HTML preview:', html.substring(0, 800));
      throw new Error('No se encontró .m3u8 en el embed de GoodStream');
    }

    if (m3u8Url.startsWith('//')) m3u8Url = 'https:' + m3u8Url;
    else if (m3u8Url.startsWith('/')) m3u8Url = new URL(embedUrl).origin + m3u8Url;

    const tracks = [];
    const tracksMatch = html.match(/tracks\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/i);
    if (tracksMatch) {
      try {
        let cleaned = tracksMatch[1]
          .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/'/g, '"');
        JSON.parse(cleaned).forEach(t => {
          if (t.kind === 'captions' || t.kind === 'subtitles' || t.kind === 'audio') {
            let file = t.file;
            if (file.startsWith('//')) file = 'https:' + file;
            else if (file.startsWith('/')) file = new URL(embedUrl).origin + file;
            tracks.push({ label: t.label || 'Unknown', file, lang: t.lang || 'es', kind: t.kind });
          }
        });
      } catch (e) {}
    }

    console.log('[GoodStream] M3U8:', m3u8Url.substring(0, 80) + '...');
    console.log('[GoodStream] Tracks:', tracks.length);

    return {
      title: VIDEO_TITLE,
      type: 'hls',
      url: m3u8Url,
      rawUrl: m3u8Url,
      proxyUrl: GOODSTREAM_WORKER + encodeURIComponent(m3u8Url),
      tracks,
      serverName: 'goodstream',
      referer: embedUrl,
      origin: 'https://goodstream.one',
      useWorkerProxy: true,
      workerUrl: GOODSTREAM_WORKER
    };

  } catch (err) {
    console.error('[GoodStream] Error:', err);
    throw err;
  }
}

// ─── RESOLUCIÓN GENÉRICA ────────────────────────────────────
async function resolveEmbedInBrowser(embedUrl) {
  embedUrl = normalizeEmbedUrl(embedUrl);
  const server = detectServer(embedUrl);
  if (!server) throw new Error('Servidor no soportado: ' + embedUrl);

  if (server === 'goodstream') return await resolveGoodStream(embedUrl);
  if (server === 'vimeos') return await resolveVimeos(embedUrl);
  if (server === 'hlswish') return await resolveHLSWish(embedUrl);

  throw new Error('Servidor no implementado: ' + server);
}

// ═══════════════════════════════════════════════════════════════
// LOADERS PERSONALIZADOS
// ═══════════════════════════════════════════════════════════════

// Loader para GoodStream, Vimeos y HLSWish: proxya TODO por el Worker
function createWorkerLoader(workerUrl) {
  return class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const url = context.url;
      if (url && url.includes('.m3u8')) reportManifest(url, 'hls', VIDEO_TITLE);

      // Proxyar si no está ya proxyado por el Worker
      if (url && !url.includes('workers.dev')) {
        context.url = workerUrl + encodeURIComponent(url);
      }

      return super.load(context, config, callbacks);
    }
  };
}

// ─── CARGAR FUENTE HLS ───────────────────────────────────────
function loadSource(source) {
  showLoading('Cargando stream HLS...');
  updateLoadingSubtext(source.serverName ? 'Servidor: ' + source.serverName : '');

  if (source.rawUrl) reportManifest(source.rawUrl, 'hls', source.title);
  if (hls) { hls.destroy(); hls = null; }

  if (source.type !== 'hls') return;

  // Poster para HLSWish
  if (source.poster) {
    video.poster = source.poster;
  }

  if (window.Hls && Hls.isSupported()) {

    let CustomLoader = undefined;
    let loadUrl = source.proxyUrl || source.url;

    if (source.useWorkerProxy) {
      CustomLoader = createWorkerLoader(GOODSTREAM_WORKER);
      console.log('[Proxy] Proxyando via Worker Cloudflare');
    }

    const hlsConfig = {
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      maxBufferSize: 60 * 1000 * 1000,
      maxBufferHole: 2.0,
      backBufferLength: 30,
      maxFragLookUpTolerance: 0.25,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 3,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 3,
      fragLoadingRetryDelay: 1000,
      seekHoleNudgeDuration: 0.1,
      enableWorker: false,
      enableSoftwareAES: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingTimeOut: 30000,
      levelLoadingTimeOut: 30000,
      fragLoadingTimeOut: 30000,
      loader: CustomLoader
    };

    hls = new Hls(hlsConfig);
    hls.loadSource(loadUrl);
    hls.attachMedia(video);

    // Eventos
    hls.on(Hls.Events.MANIFEST_LOADED, (e, data) => {
      if (data.url) reportManifest(data.url, 'hls', source.title);
    });
    hls.on(Hls.Events.LEVEL_LOADED, (e, data) => {
      if (data.details?.url) reportManifest(data.details.url, 'hls', source.title);
    });
    hls.on(Hls.Events.AUDIO_TRACK_LOADED, (e, data) => {
      if (data.details?.url) reportManifest(data.details.url, 'hls', source.title + ' (audio)');
    });
    hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, (e, data) => {
      if (data.details?.url) reportManifest(data.details.url, 'hls', source.title + ' (subtitles)');
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
      hideLoading();
      video.play().catch(() => {});
      const maxH = Math.max(...data.levels.map(l => l.height || 0));
      updateQualityBadge(maxH >= 720 ? 'HD' : (maxH >= 480 ? 'SD' : 'AUTO'));
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setupAudioTracks(hls));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (e, data) => highlightActiveAudioTrack(data.id));
    hls.on(Hls.Events.LEVEL_SWITCHED, (e, data) => {
      const lvl = hls.levels[data.level];
      if (lvl) updateQualityBadge((lvl.height || 'AUTO') + 'p');
    });
    hls.on(Hls.Events.FRAG_LOADED, () => hideSeeking());
    hls.on(Hls.Events.FRAG_LOADING, () => { if (isSeeking) showSeeking(); });

    hls.on(Hls.Events.ERROR, (e, data) => {
      console.error('[HLS ERROR]', data);
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const code = data.response?.code;
          if (code === 403 || code === 401) {
            showError('Bloqueado (HTTP ' + code + '). El token expiró.');
          } else if (code === 404) {
            showError('Video no encontrado (404).');
          } else if (code === 408 || (data.details && data.details.includes('TimeOut'))) {
            showError('Timeout. Reintentando en 2 segundos...');
            setTimeout(() => initPlayer(), 2000);
          } else {
            showError('Error de red: ' + data.details + '. Reintentando en 3 segundos...');
            setTimeout(() => initPlayer(), 3000);
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          showError('Error fatal: ' + data.details);
        }
      }
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source.proxyUrl || source.url;
    reportManifest(source.url, 'hls', source.title);
    video.addEventListener('loadedmetadata', () => {
      hideLoading();
      video.play().catch(() => {});
    }, { once: true });
  } else {
    showError('Tu navegador no soporta reproducción HLS.');
    return;
  }

  updateServerBadge(source.serverName ? source.serverName.toUpperCase() : 'AUTO');
  setupSubtitles(source.tracks || [], { useApiProxy: false });
}

// ─── INICIALIZAR ─────────────────────────────────────────────
async function initPlayer() {
  updateVideoTitle(VIDEO_TITLE);
  showLoading('Iniciando reproductor...');
  hideError();
  resetVideoSettings();

  let source;
  try {
    if (DIRECT_SRC) {
      source = {
        title: VIDEO_TITLE,
        type: 'hls',
        url: DIRECT_SRC,
        proxyUrl: DIRECT_SRC,
        tracks: [],
        serverName: 'direct',
        referer: null,
        origin: null,
        useWorkerProxy: false,
        useApiProxy: false
      };
    } else if (EMBED_URL) {
      source = await resolveEmbedInBrowser(EMBED_URL);
    } else {
      throw new Error('No se proporcionó URL. Usa ?embed=URL o ?src=URL_M3U8');
    }
  } catch (err) {
    showError('Error al iniciar: ' + err.message);
    return;
  }

  currentSource = source;
  loadSource(source);
}