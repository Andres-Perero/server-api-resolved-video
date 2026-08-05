// ═══════════════════════════════════════════════════════════════
// REPRODUCTOR MULTI-SERVIDOR HLS
// Soporta: Vimeos, GoodStream, y cualquier servidor compatible
// file:///C:/Users/Ands/Desktop/wrapper/api-resolved-vimeos/web-singler/index.html?embed=https://vimeos.net/embed-xkal207cf3kx.html
// file:///C:/Users/Ands/Desktop/wrapper/api-resolved-vimeos/web-singler/index.html?embed=https://goodstream.one/embed-810ef948gg9q.html&title=Mi%20Película
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURACIÓN DE SERVIDORES
  // ═══════════════════════════════════════════════════════════════
  const RESOLVER_API = 'https://server-api-resolved-video.onrender.com';
  //'http://localhost:3000';
  // Para producción, cambia a tu dominio:
  // const RESOLVER_API = 'https://server-api-resolved-video.onrender.com';

  // Detecta qué servidor es según la URL del embed
  function detectServer(url) {
    if (!url) return null;
    if (url.includes('vimeos')) return { name: 'vimeos', resolver: '/api/resolve-playwright' };
    if (url.includes('goodstream')) return { name: 'goodstream', resolver: '/api/resolve-playwright' };
    // Agrega más servidores aquí:
    // if (url.includes('otroserver')) return { name: 'otroserver', resolver: '/api/resolve-otros' };
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // PARÁMETROS DE URL
  // ═══════════════════════════════════════════════════════════════
  const params = new URLSearchParams(location.search);
  const EMBED_URL = params.get('embed');
  const DIRECT_SRC = params.get('src');
  const VIDEO_TITLE = params.get('title') || 'Reproduciendo';

  // ═══════════════════════════════════════════════════════════════
  // REFERENCIAS DOM
  // ═══════════════════════════════════════════════════════════════
  const video = document.getElementById('video');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const loadingSubtext = document.getElementById('loading-subtext');
  const seekingOverlay = document.getElementById('seeking-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const errorDetail = document.getElementById('error-detail');
  const errorRetryBtn = document.getElementById('error-retry-btn');
  const controlsOverlay = document.getElementById('controls-overlay');
  const videoTitleEl = document.getElementById('video-title');
  const qualityBadge = document.getElementById('quality-badge');
  const serverBadge = document.getElementById('server-badge');
  const toast = document.getElementById('toast');

  const btnPlayPause = document.getElementById('btn-play-pause');
  const btnPlayPause2 = document.getElementById('btn-play-pause-2');
  const playPauseIcon2 = document.getElementById('play-pause-icon-2');
  const btnRewind = document.getElementById('btn-rewind');
  const btnForward = document.getElementById('btn-forward');
  const btnMute = document.getElementById('btn-mute');
  const volumeIcon = document.getElementById('volume-icon');
  const btnSubtitles = document.getElementById('btn-subtitles');
  const btnAudioTrack = document.getElementById('btn-audio-track');
  const btnVideoSettings = document.getElementById('btn-video-settings');
  const btnFullscreen = document.getElementById('btn-fullscreen');

  const progressTrack = document.getElementById('progress-track');
  const progressFill = document.getElementById('progress-fill');
  const progressBuffered = document.getElementById('progress-buffered');
  const progressTooltip = document.getElementById('progress-tooltip');
  const timeCurrent = document.getElementById('time-current');
  const timeDuration = document.getElementById('time-duration');

  const volumeTrack = document.getElementById('volume-track');
  const volumeFill = document.getElementById('volume-fill');

  const subtitleMenu = document.getElementById('subtitle-menu');
  const subtitleOptions = document.getElementById('subtitle-options');
  const audioMenu = document.getElementById('audio-menu');
  const audioOptions = document.getElementById('audio-options');
  const videoSettingsMenu = document.getElementById('video-settings-menu');

  const seekFlash = document.getElementById('seek-flash');

  let hls = null;
  let controlsHideTimer = null;
  let subtitleMenuOpen = false;
  let audioMenuOpen = false;
  let videoSettingsOpen = false;
  let isSeeking = false;
  let seekDebounceTimer = null;
  let currentSource = null;

  // ═══════════════════════════════════════════════════════════════
  // TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = type || 'success';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ═══════════════════════════════════════════════════════════════
  // AJUSTES DE VIDEO (filtros CSS)
  // ═══════════════════════════════════════════════════════════════
  const videoSettings = {
    brightness: 100, contrast: 100, saturate: 100,
    'hue-rotate': 0, sepia: 0, grayscale: 0, invert: 0
  };

  function applyVideoFilters() {
    video.style.filter = [
      `brightness(${videoSettings.brightness}%)`,
      `contrast(${videoSettings.contrast}%)`,
      `saturate(${videoSettings.saturate}%)`,
      `hue-rotate(${videoSettings['hue-rotate']}deg)`,
      `sepia(${videoSettings.sepia}%)`,
      `grayscale(${videoSettings.grayscale}%)`,
      `invert(${videoSettings.invert}%)`
    ].join(' ');
  }

  function setVideoSetting(key, value) {
    videoSettings[key] = value;
    applyVideoFilters();
    updateSliderUI(key, value);
  }

  function updateSliderUI(key, value) {
    const track = document.querySelector(`[data-setting="${key}"]`);
    if (!track) return;
    const min = parseFloat(track.dataset.min);
    const max = parseFloat(track.dataset.max);
    const pct = ((value - min) / (max - min)) * 100;
    track.querySelector('.slider-fill').style.width = pct + '%';
    track.querySelector('.slider-thumb').style.left = pct + '%';
    const unit = key === 'hue-rotate' ? '°' : '%';
    const el = document.getElementById(`${key.replace('hue-rotate', 'hue')}-val`);
    if (el) el.textContent = value + unit;
  }

  function resetVideoSettings() {
    Object.assign(videoSettings, { brightness:100, contrast:100, saturate:100, 'hue-rotate':0, sepia:0, grayscale:0, invert:0 });
    applyVideoFilters();
    Object.keys(videoSettings).forEach(k => updateSliderUI(k, videoSettings[k]));
    showToast('Valores restaurados');
  }

  const presets = {
    cinema: { brightness:110, contrast:120, saturate:90, 'hue-rotate':0, sepia:15, grayscale:0, invert:0 },
    warm:   { brightness:105, contrast:105, saturate:120, 'hue-rotate':10, sepia:20, grayscale:0, invert:0 },
    cool:   { brightness:105, contrast:110, saturate:95, 'hue-rotate':-10, sepia:0, grayscale:0, invert:0 },
    bw:     { brightness:100, contrast:130, saturate:0, 'hue-rotate':0, sepia:0, grayscale:100, invert:0 }
  };

  function applyPreset(name) {
    const p = presets[name];
    if (!p) return;
    Object.assign(videoSettings, p);
    applyVideoFilters();
    Object.keys(videoSettings).forEach(k => updateSliderUI(k, videoSettings[k]));
    showToast('Preset: ' + name);
  }

  // Eventos sliders
  document.querySelectorAll('.slider-track').forEach(track => {
    const setting = track.dataset.setting;
    const min = parseFloat(track.dataset.min);
    const max = parseFloat(track.dataset.max);
    let dragging = false;

    function update(e) {
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setVideoSetting(setting, Math.round(min + pct * (max - min)));
    }

    track.addEventListener('click', update);
    track.addEventListener('mousedown', (e) => { dragging = true; update(e); });
    track.addEventListener('touchstart', (e) => { dragging = true; update(e); });
    document.addEventListener('mousemove', (e) => { if (dragging) update(e); });
    document.addEventListener('touchmove', (e) => { if (dragging) update(e); });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });
  });

  document.getElementById('btn-reset-video').addEventListener('click', resetVideoSettings);
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

// ═══════════════════════════════════════════════════════════════
  // RESOLUCIÓN DE EMBED VIA API
  // ═══════════════════════════════════════════════════════════════
  async function resolveEmbed(embedUrl) {
    const server = detectServer(embedUrl);
    if (!server) {
      throw new Error('Servidor no soportado: ' + embedUrl);
    }

    showLoading('Resolviendo stream...');
    loadingSubtext.textContent = 'Servidor: ' + server.name;

    const resolverUrl = `${RESOLVER_API}${server.resolver}?url=${encodeURIComponent(embedUrl)}`;

    try {
      const res = await fetch(resolverUrl);
      if (!res.ok) throw new Error('API ' + res.status);
      const data = await res.json();

      if (!data.url) throw new Error('No se pudo resolver el stream');

      return {
        title: VIDEO_TITLE,
        type: 'hls',
        url: data.url,           // ← Esta URL ya incluye cookies en el query param
        rawUrl: data.rawUrl || data.url,
        cookies: data.cookies || '',  // ← GUARDAR COOKIES (por si las necesitas luego)
        tracks: data.tracks || [],
        audioTracks: data.audioTracks || [],
        serverName: server.name
      };
    } catch (err) {
      console.error('Error resolviendo:', err);
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // INICIALIZAR REPRODUCTOR
  // ═══════════════════════════════════════════════════════════════
  async function initPlayer() {
    videoTitleEl.textContent = VIDEO_TITLE;
    showLoading('Iniciando...');
    hideError();
    resetVideoSettings();

    let source;

    try {
      if (DIRECT_SRC) {
        // URL HLS directa (ya resuelta)
        source = {
          title: VIDEO_TITLE,
          type: 'hls',
          url: DIRECT_SRC,
          tracks: [],
          serverName: 'direct'
        };
      } else if (EMBED_URL) {
        // Resolver embed via API
        source = await resolveEmbed(EMBED_URL);
      } else {
        throw new Error('No se proporcionó URL. Usa ?embed= o ?src=');
      }
    } catch (err) {
      showError('Error: ' + err.message);
      return;
    }

    currentSource = source;
    loadSource(source);
  }

  // ═══════════════════════════════════════════════════════════════
  // CARGAR FUENTE HLS
  // ═══════════════════════════════════════════════════════════════
  function loadSource(source) {
    showLoading('Cargando stream HLS...');
    loadingSubtext.textContent = source.serverName ? `Servidor: ${source.serverName}` : '';

    if (hls) { hls.destroy(); hls = null; }

    if (source.type === 'hls') {
      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
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
          manifestLoadingMaxRetry: 2,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 2,
          levelLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 3,
          fragLoadingRetryDelay: 500,
          seekHoleNudgeDuration: 0.1,
          enableWorker: true,
          enableSoftwareAES: true,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10
        });

        hls.loadSource(source.url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
          hideLoading();
          video.play().catch(() => {});
          const levels = data.levels;
          if (levels && levels.length) {
            const maxH = Math.max(...levels.map(l => l.height || 0));
            qualityBadge.textContent = maxH >= 720 ? 'HD' : (maxH >= 480 ? 'SD' : 'AUTO');
          }
        });

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setupAudioTracks(hls));
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (e, data) => highlightActiveAudioTrack(data.id));
        hls.on(Hls.Events.LEVEL_SWITCHED, (e, data) => {
          const lvl = hls.levels[data.level];
          if (lvl) qualityBadge.textContent = (lvl.height || 'AUTO') + 'p';
        });
        hls.on(Hls.Events.FRAG_LOADED, () => hideSeeking());
        hls.on(Hls.Events.FRAG_LOADING, () => { if (isSeeking) showSeeking(); });

        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('[HLS ERROR]', data);
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              const code = data.response?.code;
              if (code === 403 || code === 401) {
                showError(`Bloqueado (HTTP ${code}). El link expiró o falta referrer.`);
              } else if (code === 404) {
                showError('Video no encontrado (404). El link expiró.');
              } else {
                showError(`Error de red: ${data.details}. Reintentando...`);
                setTimeout(() => initPlayer(), 3000);
              }
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              showError(`Error: ${data.details}`);
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.url;
        video.addEventListener('loadedmetadata', () => {
          hideLoading();
          video.play().catch(() => {});
        }, { once: true });
      } else {
        showError('Dispositivo no soporta HLS.');
        return;
      }
    } else {
      video.src = source.url;
      video.addEventListener('loadedmetadata', () => {
        hideLoading();
        video.play().catch(() => {});
      }, { once: true });
    }

    // Mostrar nombre del servidor
    if (source.serverName) {
      serverBadge.textContent = source.serverName.toUpperCase();
    }

    setupSubtitles(source.tracks || []);
  }

  // ─── Overlays ─────────────────────────────────────────
  function showSeeking() { seekingOverlay.classList.add('visible'); }
  function hideSeeking() { seekingOverlay.classList.remove('visible'); }

  video.addEventListener('waiting', () => { showLoading('Cargando...'); showSeeking(); });
  video.addEventListener('playing', () => { hideLoading(); hideSeeking(); isSeeking = false; });
  video.addEventListener('seeking', () => { isSeeking = true; showSeeking(); });
  video.addEventListener('seeked', () => { isSeeking = false; setTimeout(hideSeeking, 200); });
  video.addEventListener('error', () => showError('Error reproduciendo video.'));

  function showLoading(text) {
    loadingText.textContent = text;
    loadingOverlay.classList.remove('hidden');
  }
  function hideLoading() { loadingOverlay.classList.add('hidden'); }
  function showError(msg) {
    errorDetail.textContent = msg;
    errorOverlay.classList.add('visible');
    hideLoading(); hideSeeking();
  }
  function hideError() { errorOverlay.classList.remove('visible'); }

  errorRetryBtn.addEventListener('click', () => initPlayer());

  // ═══════════════════════════════════════════════════════════════
  // SUBTÍTULOS (con proxy CORS)
  // ═══════════════════════════════════════════════════════════════
  async function setupSubtitles(tracks) {
    Array.from(video.querySelectorAll('track')).forEach(t => {
      if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
      t.remove();
    });
    subtitleOptions.innerHTML = '';

    addSubtitleOption('Desactivado', null, true);

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.file || t.file.includes('empty.srt') || t.file.includes('/srt/empty')) {
        continue;
      }

      const trackEl = document.createElement('track');
      trackEl.kind = 'subtitles';
      trackEl.label = t.label || 'Track ' + (i + 1);
      trackEl.srclang = t.lang || 'es';
      trackEl.id = `track-${i}`;

      try {
        // ═══════════════════════════════════════════════════════════════
        // INCLUIR COOKIES EN EL PROXY DE SUBTÍTULOS
        // ═══════════════════════════════════════════════════════════════
        const proxyUrl = `${RESOLVER_API}/api/stream?url=${encodeURIComponent(t.file)}&referer=${encodeURIComponent(EMBED_URL)}&cookies=${encodeURIComponent(currentSource?.cookies || '')}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const vttText = await res.text();
        const blob = new Blob([vttText], { type: 'text/vtt' });
        trackEl.src = URL.createObjectURL(blob);
        console.log('[SUBTITLE OK]', t.label);
      } catch (err) {
        console.warn('[SUBTITLE FALLBACK]', t.label, err.message);
        trackEl.src = t.file;
      }

      trackEl.addEventListener('error', () => {
        const opt = subtitleOptions.querySelector(`[data-track-id="track-${i}"]`);
        if (opt) {
          opt.style.opacity = '0.5';
          opt.style.pointerEvents = 'none';
          const span = opt.querySelector('span');
          if (span && !span.textContent.includes('(no disp)')) span.textContent += ' (no disp)';
        }
      });

      video.appendChild(trackEl);
      addSubtitleOption(t.label, `track-${i}`, false);
    }
    refreshFocusables();
  }

  function addSubtitleOption(label, trackId, active) {
    const opt = document.createElement('div');
    opt.className = 'menu-option focusable' + (active ? ' active' : '');
    opt.dataset.trackId = trackId || '';
    opt.innerHTML = `<span>${label}</span><span class="check">✓</span>`;
    opt.addEventListener('click', () => selectSubtitle(trackId, opt));
    subtitleOptions.appendChild(opt);
  }

  function selectSubtitle(trackId, optEl) {
    Array.from(video.textTracks).forEach(tt => tt.mode = 'disabled');
    if (trackId) {
      const trackEl = document.getElementById(trackId);
      if (trackEl && trackEl.track) {
        trackEl.track.mode = 'showing';
        showToast('Subtítulos: ' + trackEl.label);
      }
    } else {
      showToast('Subtítulos desactivados');
    }
    Array.from(subtitleOptions.children).forEach(el => el.classList.remove('active'));
    optEl.classList.add('active');
    closeSubtitleMenu();
  }

  function toggleSubtitleMenu() {
    subtitleMenuOpen = !subtitleMenuOpen;
    subtitleMenu.classList.toggle('visible', subtitleMenuOpen);
    if (subtitleMenuOpen) {
      closeOtherMenus('subtitle');
      refreshFocusables();
      focusIndex(focusables.indexOf(subtitleOptions.firstElementChild));
    }
  }
  function closeSubtitleMenu() {
    subtitleMenuOpen = false;
    subtitleMenu.classList.remove('visible');
    refreshFocusables();
  }
  btnSubtitles.addEventListener('click', toggleSubtitleMenu);

  // ═══════════════════════════════════════════════════════════════
  // PISTAS DE AUDIO (HLS.js)
  // ═══════════════════════════════════════════════════════════════
  function setupAudioTracks(hlsInstance) {
    const tracks = hlsInstance.audioTracks || [];
    if (!tracks.length) {
      btnAudioTrack.style.display = 'none';
      return;
    }
    btnAudioTrack.style.display = '';
    audioOptions.innerHTML = '';

    tracks.forEach((t) => {
      const opt = document.createElement('div');
      opt.className = 'menu-option focusable' + (t.id === hlsInstance.audioTrack ? ' active' : '');
      opt.dataset.trackId = t.id;
      opt.innerHTML = `<span>${t.name || t.lang || 'Audio ' + t.id}</span><span class="check">✓</span>`;
      opt.addEventListener('click', () => {
        hlsInstance.audioTrack = t.id;
        showToast('Audio: ' + (t.name || t.lang || 'Track ' + t.id));
        closeAudioMenu();
      });
      audioOptions.appendChild(opt);
    });
    refreshFocusables();
  }

  function highlightActiveAudioTrack(activeId) {
    Array.from(audioOptions.children).forEach(el => {
      el.classList.toggle('active', Number(el.dataset.trackId) === activeId);
    });
  }

  function toggleAudioMenu() {
    audioMenuOpen = !audioMenuOpen;
    audioMenu.classList.toggle('visible', audioMenuOpen);
    if (audioMenuOpen) {
      closeOtherMenus('audio');
      refreshFocusables();
      focusIndex(focusables.indexOf(audioOptions.firstElementChild));
    }
  }
  function closeAudioMenu() {
    audioMenuOpen = false;
    audioMenu.classList.remove('visible');
    refreshFocusables();
  }
  btnAudioTrack.addEventListener('click', toggleAudioMenu);
  btnAudioTrack.style.display = 'none';

  // ═══════════════════════════════════════════════════════════════
  // MENÚ DE AJUSTES DE VIDEO
  // ═══════════════════════════════════════════════════════════════
  function toggleVideoSettingsMenu() {
    videoSettingsOpen = !videoSettingsOpen;
    videoSettingsMenu.classList.toggle('visible', videoSettingsOpen);
    if (videoSettingsOpen) {
      closeOtherMenus('video-settings');
      refreshFocusables();
      const first = videoSettingsMenu.querySelector('.focusable');
      if (first) focusIndex(focusables.indexOf(first));
    }
  }
  function closeVideoSettingsMenu() {
    videoSettingsOpen = false;
    videoSettingsMenu.classList.remove('visible');
    refreshFocusables();
  }
  btnVideoSettings.addEventListener('click', toggleVideoSettingsMenu);

  function closeOtherMenus(except) {
    if (except !== 'subtitle') closeSubtitleMenu();
    if (except !== 'audio') closeAudioMenu();
    if (except !== 'video-settings') closeVideoSettingsMenu();
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAY / PAUSE / SEEK
  // ═══════════════════════════════════════════════════════════════
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function updatePlayIcon() {
    const icon = video.paused ? '▶' : '⏸';
    btnPlayPause.textContent = icon;
    playPauseIcon2.textContent = icon;
    btnPlayPause2.lastElementChild.textContent = video.paused ? 'Reproducir' : 'Pausar';
  }
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);

  btnPlayPause.addEventListener('click', togglePlay);
  btnPlayPause2.addEventListener('click', togglePlay);

  function seekBy(seconds) {
    video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration || Infinity);
    flashSeek(seconds > 0 ? `+${seconds}s ⏩` : `${seconds}s ⏪`);
    showControls();
  }
  btnRewind.addEventListener('click', () => seekBy(-10));
  btnForward.addEventListener('click', () => seekBy(10));

  function flashSeek(text) {
    seekFlash.textContent = text;
    seekFlash.classList.add('show');
    clearTimeout(flashSeek._t);
    flashSeek._t = setTimeout(() => seekFlash.classList.remove('show'), 500);
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
    return `${m}:${s}`;
  }

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    progressFill.style.width = pct + '%';
    progressTrack.querySelector('#progress-thumb').style.left = pct + '%';
    timeCurrent.textContent = formatTime(video.currentTime);
    timeDuration.textContent = formatTime(video.duration);
  });

  video.addEventListener('progress', () => {
    if (video.buffered.length && video.duration) {
      const end = video.buffered.end(video.buffered.length - 1);
      progressBuffered.style.width = (end / video.duration) * 100 + '%';
    }
  });

  // Progress bar con debounce
  progressTrack.addEventListener('click', (e) => {
    const rect = progressTrack.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    if (video.duration) {
      const newTime = pct * video.duration;
      if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
      isSeeking = true; showSeeking();
      progressFill.style.width = (pct * 100) + '%';
      progressTrack.querySelector('#progress-thumb').style.left = (pct * 100) + '%';
      timeCurrent.textContent = formatTime(newTime);
      seekDebounceTimer = setTimeout(() => { video.currentTime = newTime; }, 50);
    }
  });

  progressTrack.addEventListener('mousemove', (e) => {
    if (!video.duration) return;
    const rect = progressTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    progressTooltip.textContent = formatTime(pct * video.duration);
    progressTooltip.style.left = (pct * 100) + '%';
    progressTooltip.classList.add('visible');
  });
  progressTrack.addEventListener('mouseleave', () => progressTooltip.classList.remove('visible'));

  // ═══════════════════════════════════════════════════════════════
  // VOLUMEN
  // ═══════════════════════════════════════════════════════════════
  function setVolume(v) {
    video.volume = Math.min(1, Math.max(0, v));
    video.muted = video.volume === 0;
    volumeFill.style.width = (video.volume * 100) + '%';
    volumeIcon.textContent = video.muted || video.volume === 0 ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊';
  }
  setVolume(1);

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    volumeIcon.textContent = video.muted ? '🔇' : '🔊';
  });

  volumeTrack.addEventListener('click', (e) => {
    const rect = volumeTrack.getBoundingClientRect();
    setVolume((e.clientX - rect.left) / rect.width);
  });

  // ═══════════════════════════════════════════════════════════════
  // PANTALLA COMPLETA
  // ═══════════════════════════════════════════════════════════════
  btnFullscreen.addEventListener('click', () => {
    const el = document.getElementById('player-container');
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // AUTO-HIDE CONTROLES
  // ═══════════════════════════════════════════════════════════════
  function showControls() {
    controlsOverlay.classList.remove('hidden');
    clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (!video.paused && !subtitleMenuOpen && !audioMenuOpen && !videoSettingsOpen) {
        controlsOverlay.classList.add('hidden');
      }
    }, 4000);
  }
  showControls();
  video.addEventListener('click', () => { togglePlay(); showControls(); });

  // ═══════════════════════════════════════════════════════════════
  // NAVEGACIÓN POR CONTROL REMOTO
  // ═══════════════════════════════════════════════════════════════
  let focusables = [];
  let focusIdx = 0;

  function refreshFocusables() {
    let scope;
    if (subtitleMenuOpen) scope = subtitleMenu;
    else if (audioMenuOpen) scope = audioMenu;
    else if (videoSettingsOpen) scope = videoSettingsMenu;
    else scope = controlsOverlay;
    focusables = Array.from(scope.querySelectorAll('.focusable')).filter(el => el.offsetParent !== null);
    if (focusIdx >= focusables.length) focusIdx = 0;
  }

  function focusIndex(i) {
    if (!focusables.length) return;
    focusables.forEach(el => el.classList.remove('focused'));
    focusIdx = Math.min(Math.max(0, i), focusables.length - 1);
    const el = focusables[focusIdx];
    el.classList.add('focused');
    el.focus?.();
  }

  document.addEventListener('keydown', (e) => {
    showControls();
    if (errorOverlay.classList.contains('visible')) {
      if (e.key === 'Enter') errorRetryBtn.click();
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        if (subtitleMenuOpen || audioMenuOpen || videoSettingsOpen) return;
        seekBy(10); break;
      case 'ArrowLeft':
        if (subtitleMenuOpen || audioMenuOpen || videoSettingsOpen) return;
        seekBy(-10); break;
      case 'ArrowUp':
        e.preventDefault(); refreshFocusables(); focusIndex(focusIdx - 1); break;
      case 'ArrowDown':
        e.preventDefault(); refreshFocusables(); focusIndex(focusIdx + 1); break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (focusables[focusIdx]) focusables[focusIdx].click();
        else togglePlay();
        break;
      case 'Escape': case 'Backspace':
        if (subtitleMenuOpen) closeSubtitleMenu();
        else if (audioMenuOpen) closeAudioMenu();
        else if (videoSettingsOpen) closeVideoSettingsMenu();
        else if (document.fullscreenElement) document.exitFullscreen();
        break;
      case 'MediaPlayPause': togglePlay(); break;
    }
  });

  refreshFocusables();
  focusIndex(1);

  // ═══════════════════════════════════════════════════════════════
  // INICIAR
  // ═══════════════════════════════════════════════════════════════
  initPlayer();

})();