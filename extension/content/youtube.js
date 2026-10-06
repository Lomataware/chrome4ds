/**
 * Content script для YouTube (обычный + Shorts) и YouTube Music.
 * Определяет текущее видео/трек, статус воспроизведения и прогресс,
 * отправляет состояние в service worker каждые несколько секунд.
 */

(() => {
  const PLATFORM = location.hostname.includes('music.youtube.com') ? 'ytmusic' : 'youtube';
  const SEND_INTERVAL_MS = 4000;

  let lastSent = '';
  let timer = null;

  /* ---------------- Сбор данных ---------------- */

  function getPlayer() {
    return document.querySelector('video'); // <video> есть и на YT, и on YTM
  }

  function getYouTubeState() {
    const video = getPlayer();
    if (!video) return null;

    // Название: ytd-video-primary-info-renderer / заголовок документа
    const titleEl =
      document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
      document.querySelector('h1 yt-formatted-string#title') ||
      document.querySelector('meta[property="og:title"]');
    let title = titleEl
      ? (titleEl.getAttribute('content') || titleEl.textContent).trim()
      : '';

    // Канал / автор
    const channelEl =
      document.querySelector('ytd-video-owner-renderer a #channel-name') ||
      document.querySelector('a#owner .ytd-channel-name #text') ||
      document.querySelector('yt-simple-endpoint.style-scope.ytd-byline-info-renderer a');
    const channel = channelEl ? channelEl.textContent.trim() : '';

    // Обложка
    const vidMatch = location.href.match(/[?&]v=([\w-]{11})/);
    const artworkUrl = vidMatch
      ? `https://i.ytimg.com/vi/${vidMatch[1]}/mqdefault.jpg`
      : null;

    // Explicit / возрастная метка — грубая эвристика по названию
    const explicit = /\(?\s*(explicit|18\+|nsfw)\s*\)?/i.test(title);

    return buildState(video, title, channel, artworkUrl, explicit);
  }

  function getYTMusicState() {
    const video = getPlayer();
    if (!video) return null;

    const titleEl =
      document.querySelector('#song-title') ||
      document.querySelector('ytmusic-player-bar .title') ||
      document.querySelector('meta[property="og:title"]');
    let title = titleEl
      ? (titleEl.getAttribute('content') || titleEl.textContent).trim()
      : '';
    title = title.replace(/\s*[-–]\s*YouTube Music$/i, '');

    // Автор: ссылки исполнителей в player-bar
    const byline = document.querySelectorAll('ytmusic-player-bar .byline a');
    let channel = Array.from(byline).map((a) => a.textContent.trim()).join(', ');
    if (!channel) {
      const singleByline = document.querySelector('ytmusic-player-bar #byline');
      channel = singleByline ? singleByline.textContent.trim() : '';
    }
    channel = channel.replace(/^Песня\s*[·•]\s*/i, '').replace(/^Song\s*[·•]\s*/i, '');

    // Обложка из player bar
    const img = document.querySelector('ytmusic-player-bar #image img, ytmusic-player-bar image-slot img');
    const artworkUrl = img && img.src ? img.src.replace(/=[whs]-.*$/, '=w300-h300-c') : null;

    const explicit = Boolean(document.querySelector('ytmusic-player-bar #explicit-icon'));

    return buildState(video, title, channel, artworkUrl, explicit);
  }

  function buildState(video, title, channel, artworkUrl, explicit) {
    const isPlaying = !video.paused && !video.ended && video.readyState > 2;
    return {
      platform: PLATFORM,
      title: title || document.title.replace(/\s*-\s*YouTube.?$/i, '').trim(),
      channel,
      isPlaying,
      currentTime: video.currentTime || 0,
      duration: video.duration && isFinite(video.duration) ? video.duration : 0,
      url: (() => {
        try {
          const u = new URL(location.href);
          // Для YouTube важен параметр v (id видео) — сохраняем его
          if (/youtube/i.test(u.hostname)) {
            const v = u.searchParams.get('v');
            return `https://${u.hostname}${u.pathname}${v ? '?v=' + v : ''}`;
          }
          return `${u.origin}${u.pathname}`;
        } catch {
          return location.href.split(/[#?]/)[0];
        }
      })(),
      artworkUrl,
      explicit: Boolean(explicit),
      volume: Math.round((video.volume || 0) * 100)
    };
  }

  /* ---------------- Отправка ---------------- */

  function collectAndSend(force = false) {
    const state = PLATFORM === 'ytmusic' ? getYTMusicState() : getYouTubeState();
    if (!state) return;

    // Не спамим: отправляем только при изменениях (кроме тика таймера для прогресса)
    const key = JSON.stringify({ ...state, currentTime: Math.floor(state.currentTime / 15) });
    if (!force && key === lastSent) return;
    lastSent = key;

    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_STATE', state }, () => {
        void chrome.runtime.lastError; // игнорируем, если SW уснул — он проснётся
      });
    } catch (e) {
      // Extension context invalidated (после обновления расширения)
      stop();
    }
  }

  function start() {
    stop();
    timer = setInterval(() => collectAndSend(true), SEND_INTERVAL_MS);
    collectAndSend(true);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ---------------- Слушатели событий плеера ---------------- */

  // Play / Pause через HTML5 events (capture, т.к. YT не останавливает всплытие)
  document.addEventListener('play', () => collectAndSend(true), true);
  document.addEventListener('pause', () => collectAndSend(true), true);
  document.addEventListener('ended', () => collectAndSend(true), true);
  document.addEventListener('ratechange', () => collectAndSend(true), true);

  // SPA-навигация YouTube/YTM — URL меняется без перезагрузки
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => collectAndSend(true), 1500); // ждём рендера новых данных
    }
  });
  urlObserver.observe(document.documentElement, { subtree: true, childList: true });

  window.addEventListener('pagehide', () => {
    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_CLOSED' }, () => void chrome.runtime.lastError);
    } catch (e) {}
    stop();
  });

  // Старт (video может ещё не существовать)
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
