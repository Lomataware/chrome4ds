/**
 * Content script для SoundCloud.
 * Использует MediaSession API (SoundCloud сам его заполняет) как основной
 * источник данных + DOM-фоллбэк.
 */

(() => {
  const PLATFORM = 'soundcloud';
  const SEND_INTERVAL_MS = 4000;

  let lastSent = '';
  let timer = null;

  /* ---------------- Сбор данных ---------------- */

  function getPlayer() {
    return document.querySelector('audio, video');
  }

  /** Разбираем "Artist – Title" или "Title · Artist" */
  function splitArtistTitle(raw) {
    if (!raw) return { title: '', channel: '' };
    // Формат MediaSession у SoundCloud: "Title · Artist" (title первым)
    let m = raw.match(/^(.*?)\s*[·•]\s*(.+)$/);
    if (m) return { title: m[1].trim(), channel: m[2].trim() };
    // Формат document.title: "Artist — Title" (artist первым)
    m = raw.match(/^(.*?)\s+[–—-]\s+(.+)$/);
    if (m) return { title: m[2].trim(), channel: m[1].trim() };
    m = raw.match(/^(.*?)\s+by\s+(.+)$/i);
    if (m) return { title: m[1].trim(), channel: m[2].trim() };
    return { title: raw.trim(), channel: '' };
  }

  function getMediaSessionState() {
    const ms = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!ms || !ms.title) return null;
    return {
      title: ms.title,
      // artist у SC обычно "Artist · Album" — берём первую часть
      channel: (ms.artist || '').split(/\s*[·•]\s*/)[0],
      artworkUrl: ms.artwork && ms.artwork.length ? ms.artwork[ms.artwork.length - 1].src : null
    };
  }

  function getDomState() {
    const titleEl =
      document.querySelector('.playbackSoundBadge__titleLink, .trackInfoItem__title') ||
      document.querySelector('a.playbackSoundBadge__titleLink span:nth-child(2)');
    const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
    const art = document.querySelector('.playbackSoundBadge__avatar img, .coverArtImage');
    const explicit = Boolean(document.querySelector('.badgeMinimalExplicit'));

    let title = titleEl ? titleEl.textContent.trim() : '';
    let channel = artistEl ? artistEl.textContent.trim() : '';

    // Если заголовок не найден — пробуем разобрать document.title ("Track by Artist | SoundCloud")
    if (!title) {
      const parsed = splitArtistTitle(
        document.title.replace(/\s*\|?\s*Stream .*? Listen to .*? tracks on SoundCloud\.?$/is, '').replace(/\s*\|\s*SoundCloud.*$/i, '')
      );
      title = parsed.title;
      channel = channel || parsed.channel;
    }

    return {
      title,
      channel,
      artworkUrl: art && art.src ? art.src.replace(/\u2026|_large|_small/, '') : null,
      explicit
    };
  }

  function collectState() {
    const player = getPlayer();
    if (!player) return null;

    const meta = getMediaSessionState() || getDomState();
    if (!meta.title) return null;

    const isPlaying = !player.paused && !player.ended;
    // SoundCloud использует MediaSession position state
    let playbackState = 'paused';
    try {
      if (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing') {
        playbackState = 'playing';
      }
    } catch (e) {}

    return {
      platform: PLATFORM,
      title: meta.title,
      channel: meta.channel || '',
      isPlaying: isPlaying || playbackState === 'playing',
      currentTime: player.currentTime || 0,
      duration: player.duration && isFinite(player.duration) ? player.duration : 0,
      url: location.href.split('#')[0],
      artworkUrl: meta.artworkUrl,
      explicit: Boolean(meta.explicit),
      volume: Math.round((player.volume || 0) * 100)
    };
  }

  /* ---------------- Отправка ---------------- */

  function sendState(force = false) {
    const state = collectState();
    if (!state) return;

    const key = JSON.stringify({ ...state, currentTime: Math.floor(state.currentTime / 15) });
    if (!force && key === lastSent) return;
    lastSent = key;

    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_STATE', state }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      stop();
    }
  }

  function start() {
    stop();
    timer = setInterval(() => sendState(true), SEND_INTERVAL_MS);
    sendState(true);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ---------------- События ---------------- */

  document.addEventListener('play', () => sendState(true), true);
  document.addEventListener('pause', () => sendState(true), true);
  document.addEventListener('ended', () => sendState(true), true);

  // SoundCloud меняет трек без перезагрузки страницы
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => sendState(true), 1000);
    }
  }).observe(document.documentElement, { subtree: true, childList: true });

  window.addEventListener('pagehide', () => {
    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_CLOSED' }, () => void chrome.runtime.lastError);
    } catch (e) {}
    stop();
  });

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
