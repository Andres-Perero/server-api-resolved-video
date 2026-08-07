// ═══════════════════════════════════════════════════════════════
// PLAYER-CORE.JS — Frontend Dual:
// Vimeos: resolución via API backend (Playwright) + proxy del backend
// GoodStream: resolución via Worker Cloudflare
// Directo: reproduce M3U8 directamente
// ═══════════════════════════════════════════════════════════════

// ─── CONFIGURACIÓN ──────────────────────────────────────────
const API_BASE_URL = 'http://localhost:3000'; // ← Cambia esto
const GOODSTREAM_WORKER = 'https://goodstream-proxy-render.ff15.workers.dev/?url=';

// ─── ESTADO GLOBAL ───────────────────────────────────────────
const capturedManifests = new Set();
let currentSource = null;
let hls = null;

// ─── DETECTAR SERVIDOR ──────────────────────────────────────
function detectServer(url) {
  if (!url) return null;
  if (url.includes('goodstream')) return 'goodstream';
  if (url.includes('vimeos')) return 'vimeos';
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
// RESOLUCIÓN VIMEOS — via API Backend (Playwright)
// ═══════════════════════════════════════════════════════════════

async function resolveVimeos(embedUrl) {
  showLoading('Resolviendo Vimeos...');
  updateLoadingSubtext('Conectando con servidor de resolución...');

  try {
    const apiUrl = API_BASE_URL + '/api/resolve?url=' + encodeURIComponent(embedUrl);
    console.log('[Vimeos] Llamando API:', apiUrl);

    const res = await fetch(apiUrl);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      throw new Error(err.error || 'HTTP ' + res.status);
    }

    const data = await res.json();
    console.log('[Vimeos] API response:', data);

    if (!data.url) {
      throw new Error('La API no devolvió URL del stream');
    }

    const proxyUrl = API_BASE_URL + '/api/proxy?session=' + data.sessionId + '&url=';
    const proxiedM3U8 = proxyUrl + encodeURIComponent(data.url);

    const proxiedTracks = (data.tracks || []).map(t => ({
      ...t,
      file: proxyUrl + encodeURIComponent(t.file)
    }));

    return {
      title: VIDEO_TITLE,
      type: 'hls',
      url: data.url,
      rawUrl: data.url,
      proxyUrl: proxiedM3U8,
      tracks: proxiedTracks,
      audioTracks: data.audioTracks || [],
      serverName: 'vimeos',
      referer: data.referer,
      origin: null,
      useApiProxy: true,
      proxyBase: proxyUrl,
      sessionId: data.sessionId,
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
  const server = detectServer(embedUrl);
  if (!server) throw new Error('Servidor no soportado: ' + embedUrl);

  if (server === 'goodstream') return await resolveGoodStream(embedUrl);
  if (server === 'vimeos') return await resolveVimeos(embedUrl);

  throw new Error('Servidor no implementado: ' + server);
}

// ═══════════════════════════════════════════════════════════════
// LOADERS PERSONALIZADOS
// ═══════════════════════════════════════════════════════════════

function createWorkerLoader(workerUrl) {
  return class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const url = context.url;
      if (url && url.includes('.m3u8')) reportManifest(url, 'hls', VIDEO_TITLE);

      if (url && !url.includes('workers.dev')) {
        context.url = workerUrl + encodeURIComponent(url);
      }

      return super.load(context, config, callbacks);
    }
  };
}

function createApiProxyLoader(proxyBase) {
  return class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const url = context.url;
      if (url && url.includes('.m3u8')) reportManifest(url, 'hls', VIDEO_TITLE);

      if (url && !url.includes('/api/proxy')) {
        context.url = proxyBase + encodeURIComponent(url);
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

  if (window.Hls && Hls.isSupported()) {

    let CustomLoader = undefined;
    let loadUrl = source.proxyUrl || source.url;

    if (source.useWorkerProxy) {
      CustomLoader = createWorkerLoader(GOODSTREAM_WORKER);
      console.log('[GoodStream] Proxyando via Worker');
    } else if (source.useApiProxy) {
      CustomLoader = createApiProxyLoader(source.proxyBase);
      console.log('[Vimeos] Proxyando via API');
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
  
  // PASAMOS sourceInfo para que setupSubtitles sepa si usar proxy o fetch
  setupSubtitles(source.tracks || [], { useApiProxy: source.useApiProxy });
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