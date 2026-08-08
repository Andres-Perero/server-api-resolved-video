// ═══════════════════════════════════════════════════════════════
// PLAYER-UI.JS — UI, controles, settings, navegación, subtítulos
// Soporta: tracks de audio/subtítulos desde HLS.js Y desde el embed
// ═══════════════════════════════════════════════════════════════

// ─── CONSTANTES GLOBALES ────────────────────────────────────
const params = new URLSearchParams(location.search);
const EMBED_URL = params.get('embed');
const DIRECT_SRC = params.get('src');
const VIDEO_TITLE = params.get('title') || 'Reproduciendo';

// ─── DOM REFS ────────────────────────────────────────────────
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

// ─── ESTADO UI ───────────────────────────────────────────────
let controlsHideTimer = null;
let subtitleMenuOpen = false;
let audioMenuOpen = false;
let videoSettingsOpen = false;
let isSeeking = false;
let seekDebounceTimer = null;
let focusables = [];
let focusIdx = 0;

// Tracks de audio desde el embed (para GoodStream)
let embedAudioTracks = [];
let currentEmbedAudioTrack = null;

// ═══════════════════════════════════════════════════════════════
// FUNCIONES DE UI
// ═══════════════════════════════════════════════════════════════

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() { loadingOverlay.classList.add('hidden'); }
function updateLoadingSubtext(text) { loadingSubtext.textContent = text; }

function showError(msg) {
  errorDetail.innerHTML = msg;
  errorOverlay.classList.add('visible');
  hideLoading(); hideSeeking();
}
function hideError() { errorOverlay.classList.remove('visible'); }

function showSeeking() { seekingOverlay.classList.add('visible'); }
function hideSeeking() { seekingOverlay.classList.remove('visible'); }

function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = type || 'success';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function updateVideoTitle(title) { videoTitleEl.textContent = title; }
function updateQualityBadge(text) { qualityBadge.textContent = text; }
function updateServerBadge(text) { serverBadge.textContent = text; }

// ═══════════════════════════════════════════════════════════════
// VIDEO SETTINGS (filtros CSS)
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

// Sliders
function initSliders() {
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
}

// ═══════════════════════════════════════════════════════════════
// SUBTÍTULOS (desde embed + HLS.js)
// ═══════════════════════════════════════════════════════════════
async function setupSubtitles(tracks, sourceInfo = {}) {
  Array.from(video.querySelectorAll('track')).forEach(t => {
    if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
    t.remove();
  });
  subtitleOptions.innerHTML = '';
  addSubtitleOption('Desactivado', null, true);

  const subtitleTracks = tracks.filter(t => {
    if (!t.file || t.file.includes('empty.srt') || t.file.includes('/srt/empty')) return false;
    if (t.kind === 'captions' || t.kind === 'subtitles') return true;
    if (t.kind === 'audio') return false;
    const ext = (t.file || '').split('.').pop()?.toLowerCase();
    return ext === 'vtt' || ext === 'srt' || (!t.kind && t.label);
  });
  embedAudioTracks = tracks.filter(t => t.kind === 'audio');

  console.log('[setupSubtitles] Total tracks recibidos:', tracks.length);
  console.log('[setupSubtitles] Subtitle tracks:', subtitleTracks.length);
  console.log('[setupSubtitles] Embed audio tracks:', embedAudioTracks.length);

  const isApiProxied = sourceInfo.useApiProxy === true;

  for (let i = 0; i < subtitleTracks.length; i++) {
    const t = subtitleTracks[i];

    if (!t.file || t.file.includes('empty.srt') || t.file.includes('/srt/empty') || t.file === '') {
      console.log('[setupSubtitles] Saltando track vacío:', t.label);
      continue;
    }

    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = t.label || 'Track ' + (i + 1);
    trackEl.srclang = t.lang || 'es';
    trackEl.id = `track-${i}`;

    if (isApiProxied) {
      trackEl.src = t.file;
      console.log('[setupSubtitles] Usando URL proxyada directa:', t.file.substring(0, 60));
    } else {
      let useDirectUrl = true;
      try {
        console.log('[setupSubtitles] Intentando fetch:', t.file.substring(0, 60));
        const res = await fetch(t.file, { method: 'GET', mode: 'cors' });

        if (res.ok) {
          const text = await res.text();
          if (text.includes('WEBVTT') || text.includes('<c.') || text.trim().startsWith('1\n')) {
            const blob = new Blob([text], { type: 'text/vtt' });
            trackEl.src = URL.createObjectURL(blob);
            useDirectUrl = false;
            console.log('[setupSubtitles] ✅ Blob creado para:', t.label);
          } else {
            console.warn('[setupSubtitles] ⚠️ Contenido no válido para:', t.label, text.substring(0, 50));
          }
        } else {
          console.warn('[setupSubtitles] ⚠️ HTTP', res.status, 'para:', t.label);
        }
      } catch (err) {
        console.warn('[setupSubtitles] ⚠️ Fetch falló para:', t.label, err.message);
      }

      if (useDirectUrl) {
        trackEl.src = t.file;
        console.log('[setupSubtitles] Usando URL directa:', t.file.substring(0, 60));
      }
    }

    trackEl.addEventListener('error', (e) => {
      console.error('[Track Error]', t.label, e);
      const opt = subtitleOptions.querySelector(`[data-track-id="track-${i}"]`);
      if (opt) {
        opt.style.opacity = '0.5';
        opt.style.pointerEvents = 'none';
        const span = opt.querySelector('span');
        if (span && !span.textContent.includes('(no disp)')) span.textContent += ' (no disp)';
      }
    });

    trackEl.addEventListener('load', () => {
      console.log('[Track Load] ✅', t.label);
    });

    video.appendChild(trackEl);
    addSubtitleOption(t.label, `track-${i}`, false);
  }

  console.log('[setupSubtitles] Tracks agregados al video:', video.querySelectorAll('track').length);
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
  console.log('[selectSubtitle] Seleccionando track:', trackId);

  Array.from(video.textTracks).forEach(tt => {
    tt.mode = 'disabled';
    console.log('[selectSubtitle] Desactivado:', tt.label);
  });

  if (trackId) {
    const trackEl = document.getElementById(trackId);
    if (trackEl && trackEl.track) {
      trackEl.track.mode = 'showing';
      console.log('[selectSubtitle] ✅ Activado:', trackEl.label, 'mode:', trackEl.track.mode);
      showToast('Subtítulos: ' + trackEl.label);
    } else {
      console.error('[selectSubtitle] ❌ No se encontró el track:', trackId);
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

// ═══════════════════════════════════════════════════════════════
// PISTAS DE AUDIO (HLS.js + embed tracks)
// ═══════════════════════════════════════════════════════════════
function setupAudioTracks(hlsInstance) {
  const hlsTracks = hlsInstance.audioTracks || [];
  const allTracks = [];

  hlsTracks.forEach(t => {
    allTracks.push({
      id: 'hls-' + t.id,
      name: t.name || t.lang || 'Audio ' + t.id,
      lang: t.lang,
      source: 'hls',
      hlsId: t.id
    });
  });

  embedAudioTracks.forEach((t, idx) => {
    allTracks.push({
      id: 'embed-' + idx,
      name: t.label || t.lang || 'Audio ' + (idx + 1),
      lang: t.lang,
      source: 'embed',
      file: t.file,
      embedIdx: idx
    });
  });

  if (!allTracks.length) {
    btnAudioTrack.style.display = 'none';
    return;
  }

  btnAudioTrack.style.display = '';
  audioOptions.innerHTML = '';

  allTracks.forEach((t) => {
    const opt = document.createElement('div');
    const isActive = t.source === 'hls' 
      ? (hlsInstance.audioTrack === t.hlsId)
      : (currentEmbedAudioTrack === t.embedIdx);

    opt.className = 'menu-option focusable' + (isActive ? ' active' : '');
    opt.dataset.trackId = t.id;
    opt.dataset.source = t.source;
    if (t.source === 'hls') opt.dataset.hlsId = String(t.hlsId);
    if (t.source === 'embed') opt.dataset.embedIdx = String(t.embedIdx);
    opt.innerHTML = `<span>${t.name}${t.source === 'embed' ? ' (Ext)' : ''}</span><span class="check">✓</span>`;

    opt.addEventListener('click', () => {
      if (t.source === 'hls') {
        hlsInstance.audioTrack = t.hlsId;
        currentEmbedAudioTrack = null;
        highlightActiveAudioTrack(t.hlsId);
      } else {
        switchEmbedAudioTrack(t.embedIdx, t.file);
        highlightActiveAudioTrack();
      }
      showToast('Audio: ' + t.name);
      closeAudioMenu();
    });

    audioOptions.appendChild(opt);
  });

  refreshFocusables();
}

function switchEmbedAudioTrack(idx, fileUrl) {
  currentEmbedAudioTrack = idx;
  const currentTime = video.currentTime;
  const wasPlaying = !video.paused;
  console.log('[SWITCH AUDIO]', idx, fileUrl);
  highlightActiveAudioTrack();
}

function highlightActiveAudioTrack(activeId) {
  const hlsInst = (typeof hls !== 'undefined' && hls) ? hls : null;
  const currentHlsId = (activeId !== undefined && activeId !== null)
    ? activeId
    : (hlsInst ? hlsInst.audioTrack : null);

  Array.from(audioOptions.children).forEach(el => {
    const source = el.dataset.source;
    let isActive = false;
    if (source === 'hls') {
      const trackHlsId = Number(el.dataset.hlsId);
      isActive = currentHlsId !== null && currentHlsId !== undefined && trackHlsId === Number(currentHlsId);
    } else {
      isActive = Number(el.dataset.embedIdx) === currentEmbedAudioTrack;
    }
    el.classList.toggle('active', isActive);
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

function closeOtherMenus(except) {
  if (except !== 'subtitle') closeSubtitleMenu();
  if (except !== 'audio') closeAudioMenu();
  if (except !== 'video-settings') closeVideoSettingsMenu();
}

// ═══════════════════════════════════════════════════════════════
// PLAY / PAUSE / SEEK / TIME
// ═══════════════════════════════════════════════════════════════
function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function updatePlayIcon() {
  const paused = video.paused;
  // Centro: alternar iconos SVG sin destruir el markup
  if (btnPlayPause) {
    btnPlayPause.classList.toggle('is-paused', paused);
    btnPlayPause.classList.toggle('is-playing', !paused);
    btnPlayPause.setAttribute('title', paused ? 'Reproducir' : 'Pausar');
  }
  if (playPauseIcon2) playPauseIcon2.textContent = paused ? '▶' : '⏸';
  if (btnPlayPause2 && btnPlayPause2.lastElementChild) {
    btnPlayPause2.lastElementChild.textContent = paused ? 'Reproducir' : 'Pausar';
  }
}

function seekBy(seconds) {
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration || Infinity);
  flashSeek(seconds > 0 ? `+${seconds}s ⏩` : `${seconds}s ⏪`);
  showControls();
}

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

// ═══════════════════════════════════════════════════════════════
// VOLUMEN
// ═══════════════════════════════════════════════════════════════
function setVolume(v) {
  video.volume = Math.min(1, Math.max(0, v));
  video.muted = video.volume === 0;
  volumeFill.style.width = (video.volume * 100) + '%';
  volumeIcon.textContent = video.muted || video.volume === 0 ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊';
}

// ═══════════════════════════════════════════════════════════════
// PANTALLA COMPLETA
// ═══════════════════════════════════════════════════════════════
function toggleFullscreen() {
  const el = document.getElementById('player-container');
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-HIDE CONTROLES
// ═══════════════════════════════════════════════════════════════
function showControls() {
  controlsOverlay.classList.remove('hidden');
  document.getElementById('player-container')?.classList.remove('controls-hidden');
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    if (!video.paused && !subtitleMenuOpen && !audioMenuOpen && !videoSettingsOpen) {
      controlsOverlay.classList.add('hidden');
      document.getElementById('player-container')?.classList.add('controls-hidden');
    }
  }, 4000);
}

function bindControlsActivity() {
  const root = document.getElementById('player-container');
  if (!root || root.dataset.activityBound) return;
  root.dataset.activityBound = '1';
  const wake = () => showControls();
  ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach((ev) => {
    root.addEventListener(ev, wake, { passive: true });
  });
  // Al pausar, dejar controles visibles
  video.addEventListener('pause', () => {
    clearTimeout(controlsHideTimer);
    controlsOverlay.classList.remove('hidden');
    root.classList.remove('controls-hidden');
  });
  video.addEventListener('play', () => showControls());
}

// ═══════════════════════════════════════════════════════════════
// NAVEGACIÓN POR CONTROL REMOTO
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// INICIALIZAR EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
function initUI() {
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('waiting', () => { showLoading('Cargando...'); showSeeking(); });
  video.addEventListener('playing', () => { hideLoading(); hideSeeking(); isSeeking = false; });
  video.addEventListener('seeking', () => { isSeeking = true; showSeeking(); });
  video.addEventListener('seeked', () => { isSeeking = false; setTimeout(hideSeeking, 200); });
  video.addEventListener('error', () => showError('Error reproduciendo video.'));
  video.addEventListener('click', () => { togglePlay(); showControls(); });

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

  btnPlayPause.addEventListener('click', togglePlay);
  btnPlayPause2.addEventListener('click', togglePlay);
  btnRewind.addEventListener('click', () => seekBy(-10));
  btnForward.addEventListener('click', () => seekBy(10));
  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    volumeIcon.textContent = video.muted ? '🔇' : '🔊';
  });
  btnSubtitles.addEventListener('click', toggleSubtitleMenu);
  btnAudioTrack.addEventListener('click', toggleAudioMenu);
  btnVideoSettings.addEventListener('click', toggleVideoSettingsMenu);
  btnFullscreen.addEventListener('click', toggleFullscreen);
  errorRetryBtn.addEventListener('click', () => initPlayer());

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

  setVolume(1);
  volumeTrack.addEventListener('click', (e) => {
    const rect = volumeTrack.getBoundingClientRect();
    setVolume((e.clientX - rect.left) / rect.width);
  });

  initSliders();

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

  showControls();
  refreshFocusables();
  focusIndex(1);
}