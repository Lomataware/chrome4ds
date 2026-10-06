/**
 * Service Worker (background) — центральный модуль расширения.
 * Получает медиа-состояние от content-скриптов, хранит настройки и
 * проксирует их в Discord RPC.
 */

import { DiscordRPC } from './discord_rpc.js';

const rpc = new DiscordRPC();

/* ------------------------------------------------------------------ */
/* Дефолтные настройки                                                  */
/* ------------------------------------------------------------------ */
const DEFAULT_SETTINGS = {
  enabled: true,                 // главное включ/выкл
  clientId: '',                  // Application ID из Discord Dev Portal
  accessToken: '',               // OAuth2 access token (scope: rpc)
  refreshToken: '',
  tokenExpiry: 0,
  showTitle: true,               // details: название видео/трека
  showChannel: true,             // state: канал / автор
  showProgress: true,            // timestamps (сколько прошло / осталось)
  showButtons: true,             // кнопки "Watch on YouTube" / "Listen on SoundCloud"
  hideSensitive: false,          // не показывать статус, если контент для взрослых
  pauseBehavior: 'hide',         // 'hide' | 'showPaused' | 'keep'
  updateIntervalSec: 5,          // частота обновления presence
  platforms: {
    youtube: true,
    ytmusic: true,
    soundcloud: true
  }
};

let settings = { ...DEFAULT_SETTINGS };
let lastMediaState = null;      // последнее полученное состояние медиа
let lastPresenceKey = '';       // чтобы не слать одинаковый presence часто
let tabStates = {};             // tabId -> mediaState (мульти-вкладка)

/* ------------------------------------------------------------------ */
/* Инициализация                                                        */
/* ------------------------------------------------------------------ */
async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  settings.platforms = { ...DEFAULT_SETTINGS.platforms, ...(settings.platforms || {}) };
  // Токены — из local (см. saveSettings) + миграция старых версий,
  // где они случайно попадали в sync.
  const localStored = await chrome.storage.local.get('auth');
  if (localStored.auth) {
    settings.accessToken = localStored.auth.accessToken || '';
    settings.refreshToken = localStored.auth.refreshToken || '';
    settings.tokenExpiry = localStored.auth.tokenExpiry || 0;
  } else if (stored.settings && stored.settings.accessToken) {
    await saveSettings(); // переносим токены из sync в local
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  chrome.alarms.create('drp-refresh', { periodInMinutes: 0.5 });
  console.log('[DRP] Extension installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  if (settings.accessToken && settings.enabled) {
    tryConnect().catch(() => {});
  }
});

(async () => {
  await loadSettings();
  if (settings.enabled && settings.accessToken && settings.clientId) {
    tryConnect().catch(console.warn);
  }
})();

/* ------------------------------------------------------------------ */
/* Auth (OAuth2 Device Flow / Manual Token)                             */
/* ------------------------------------------------------------------ */

const DISCORD_API = 'https://discord.com/api';
const DEVICE_SCOPE = 'rpc identify';
const DEVICE_POLL_ALARM = 'drp-device-poll';

let deviceFlow = null;          // активный Device Flow: {clientId, deviceCode, intervalMs, expiresAt}
let devicePollBusy = false;     // предыдущий запрос ещё не завершился
let lastDeviceError = '';       // последняя ошибка — для показа в popup

let connectingPromise = null; // защита от параллельных подключений

async function tryConnect() {
  if (rpc.connected) return true;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    try {
      await refreshAccessTokenIfNeeded();
      if (!settings.accessToken || !settings.clientId) return false;
      await rpc.connect(settings.accessToken, settings.clientId);
      return true;
    } finally {
      connectingPromise = null;
    }
  })();
  return connectingPromise;
}

async function refreshAccessTokenIfNeeded() {
  if (!settings.refreshToken) return;
  // Токен жив ещё > 5 минут — ничего не делаем
  if (Date.now() < settings.tokenExpiry - 5 * 60 * 1000) return;

  try {
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: '',           // пустой для публичных приложений PKCE
        grant_type: 'refresh_token',
        refresh_token: settings.refreshToken
      })
    });
    if (res.ok) {
      const data = await res.json();
      settings.accessToken = data.access_token;
      settings.refreshToken = data.refresh_token || settings.refreshToken;
      settings.tokenExpiry = Date.now() + data.expires_in * 1000;
      await saveWithAuth();
      console.log('[DRP] Access token refreshed');
    }
  } catch (e) {
    console.error('[DRP] Token refresh failed', e);
  }
}

async function saveSettings() {
  // ВАЖНО: токены храним ОТДЕЛЬНО в chrome.storage.local.
  // chrome.storage.sync имеет лимит ~8 КБ на значение и синхронизируется
  // через аккаунт Google — из-за этого длинные access/refresh-токены
  // раньше сохранялись молча с ошибкой, и «Получить токен» не работал.
  const auth = {
    accessToken: settings.accessToken || '',
    refreshToken: settings.refreshToken || '',
    tokenExpiry: settings.tokenExpiry || 0
  };
  const { accessToken, refreshToken, tokenExpiry, ...syncable } = settings;
  void accessToken; void refreshToken; void tokenExpiry;
  settings = syncable;

  await chrome.storage.local.set({ auth });
  await chrome.storage.sync.set({ settings });
}

async function loadAuth() {
  const stored = await chrome.storage.local.get('auth');
  const auth = stored.auth || {};
  settings.accessToken = auth.accessToken || '';
  settings.refreshToken = auth.refreshToken || '';
  settings.tokenExpiry = auth.tokenExpiry || 0;
}

async function clearAuth() {
  settings.accessToken = '';
  settings.refreshToken = '';
  settings.tokenExpiry = 0;
  await chrome.storage.local.remove('auth');
}

/* Сохранение после операций с токенами: сначала записываем auth в local
   (пока поля ещё есть в settings), затем — очищенные настройки в sync. */
async function saveWithAuth() {
  const auth = {
    accessToken: settings.accessToken || '',
    refreshToken: settings.refreshToken || '',
    tokenExpiry: settings.tokenExpiry || 0
  };
  await chrome.storage.local.set({ auth });
  await saveSettings();
}

/* ------------------------------------------------------------------ */
/* Discord OAuth2 Device Flow (выполняется в service worker)            */
/*                                                                      */
/* Раньше запросы шли напрямую из popup, и страница discord.com/activate*/
/* не открывалась по двум причинам:                                    */
/*  1) window.open() из popup закрывается вместе с popup — переход       */
/*     обрывался;                                                        */
/*  2) fetch к discord.com блокировался CORS (popup не покрыт            */
/*     host_permissions).                                               */
/* Теперь код запрашивает background, а ссылку открывает chrome.tabs.   */
/* ------------------------------------------------------------------ */

async function startDeviceFlow(clientId) {
  const res = await fetch(`${DISCORD_API}/oauth2/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE })
  });

  let data = {};
  try { data = await res.json(); } catch (e) { /* HTML-ответ от Cloudflare/прокси */ }

  if (!res.ok || !data.device_code || !data.user_code) {
    throw new Error(buildDiscordError(res.status, data));
  }

  deviceFlow = {
    clientId,
    deviceCode: data.device_code,
    intervalMs: Math.max(data.interval || 5, 3) * 1000,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000
  };
  lastDeviceError = '';

  // Открываем страницу авторизации НОВОЙ вкладкой (не завися от popup-окна)
  const verifyUrl = data.verification_uri_complete || data.verification_uri || 'https://discord.com/authorize';
  await chrome.tabs.create({ url: verifyUrl, active: true });

  // Опрос через alarm — переживает «засыпание» service worker'а в MV3
  chrome.alarms.create(DEVICE_POLL_ALARM, { periodInMinutes: Math.max(deviceFlow.intervalMs / 60000, 0.5) });
  pollDeviceToken().catch(() => {}); // первый опрос сразу, дальше — по alarm

  return { userCode: data.user_code, verificationUri: verifyUrl, expiresIn: data.expires_in || 900 };
}

function buildDiscordError(status, data) {
  const code = data.error_description || data.error || data.message || JSON.stringify(data);
  if (status === 400 && /invalid.*client/i.test(String(code))) {
    return `Неверный Application ID (${code}). Скопируйте Client ID со страницы General Information вашего приложения на discord.com/developers/applications`;
  }
  if (status === 403 || status === 429) {
    return `Discord отклонил запрос (HTTP ${status}): ${code}. Попробуйте позже — возможно, сработала защита от ботов/флуда.`;
  }
  if (status >= 500) {
    return `Ошибка сервера Discord (HTTP ${status}). Попробуйте ещё раз через минуту.`;
  }
  return `HTTP ${status}: ${code}`;
}

async function pollDeviceToken() {
  if (!deviceFlow || devicePollBusy) return;
  if (Date.now() > deviceFlow.expiresAt) {
    stopDeviceFlow();
    lastDeviceError = 'Код истёк. Нажмите «Получить токен» ещё раз.';
    return;
  }

  devicePollBusy = true;
  try {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: deviceFlow.clientId,
        scope: DEVICE_SCOPE,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceFlow.deviceCode
      })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.access_token) {
      settings.accessToken = data.access_token;
      settings.refreshToken = data.refresh_token || '';
      settings.tokenExpiry = Date.now() + (data.expires_in || 30 * 24 * 3600) * 1000;
      settings.clientId = deviceFlow.clientId;
      stopDeviceFlow();
      await saveWithAuth();
      try {
        await tryConnect();
        applyCurrentMedia();
      } catch (e) {
        lastDeviceError = 'Токен получен, но подключиться не удалось: ' + e.message;
      }
    } else if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      if (data.error === 'slow_down') deviceFlow.intervalMs += 5000; // RFC 8628
    } else if (data.error === 'expired_token' || data.error === 'invalid_grant') {
      stopDeviceFlow();
      lastDeviceError = 'Код истёк или отклонён. Начните заново.';
    } else if (data.error) {
      stopDeviceFlow();
      lastDeviceError = 'Discord вернул ошибку: ' + (data.error_description || data.error);
    }
  } catch (e) {
    // Сеть моргнула — просто продолжим опрос по alarm
    console.warn('[DRP] device poll network error', e);
  } finally {
    devicePollBusy = false;
  }
}

function stopDeviceFlow() {
  deviceFlow = null;
  chrome.alarms.clear(DEVICE_POLL_ALARM);
}

/* ------------------------------------------------------------------ */
/* Приём сообщений от content-скриптов и popup                          */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      /* Content script прислал состояние плеера */
      case 'MEDIA_STATE': {
        const tabId = sender.tab?.id ?? 0;
        const state = msg.state; // { platform, title, channel, isPlaying, currentTime, duration, url, artworkUrl, explicit }
        tabStates[tabId] = state;

        // Пытаемся восстановить/установить соединение (SW мог уснуть)
        if (settings.enabled && settings.accessToken && settings.clientId && !rpc.connected) {
          tryConnect()
            .then((ok) => { if (ok) applyMediaState(state); })
            .catch(() => {});
        } else {
          // Активная вкладка имеет приоритет
          const activeTab = await getActiveMediaTab();
          if (activeTab != null && tabStates[activeTab]) {
            applyMediaState(tabStates[activeTab]);
          } else {
            applyMediaState(state);
          }
        }
        sendResponse({ ok: true });
        break;
      }

      /* Вкладка закрылась */
      case 'MEDIA_CLOSED': {
        delete tabStates[sender.tab?.id ?? 0];
        const activeTab = await getActiveMediaTab();
        if (activeTab && tabStates[activeTab]) {
          applyMediaState(tabStates[activeTab]);
        } else {
          clearPresence();
        }
        sendResponse({ ok: true });
        break;
      }

      /* Popup запросил текущий статус */
      case 'GET_STATUS': {
        sendResponse({
          connected: rpc.connected,
          enabled: settings.enabled,
          activity: rpc.currentActivity,
          settings,
          hasToken: Boolean(settings.accessToken),
          deviceFlowActive: Boolean(deviceFlow),
          deviceError: lastDeviceError || null
        });
        break;
      }

      /* Popup обновил настройки */
      case 'SAVE_SETTINGS': {
        settings = { ...settings, ...msg.settings };
        settings.platforms = { ...DEFAULT_SETTINGS.platforms, ...(msg.settings.platforms || {}) };
        await saveSettings();
        if (!settings.enabled) {
          rpc.clearActivity();
        } else if (settings.accessToken && settings.clientId) {
          tryConnect().then(() => applyCurrentMedia()).catch(console.warn);
        }
        sendResponse({ ok: true });
        break;
      }

      /* Popup: запуск Device Flow (fetch + открытие вкладки — в background) */
      case 'START_DEVICE_FLOW': {
        try {
          const info = await startDeviceFlow(msg.clientId);
          sendResponse({ ok: true, ...info });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      /* Popup: статус активного Device Flow (popup мог быть закрыт) */
      case 'DEVICE_FLOW_STATUS': {
        sendResponse({
          ok: true,
          active: Boolean(deviceFlow),
          error: lastDeviceError || null,
          connected: rpc.connected,
          hasToken: Boolean(settings.accessToken)
        });
        break;
      }

      /* Popup: вручную сохранить токены (для продвинутых пользователей) */
      case 'SET_TOKENS': {
        settings.accessToken = msg.accessToken || '';
        settings.refreshToken = msg.refreshToken || '';
        settings.clientId = msg.clientId || settings.clientId;
        settings.tokenExpiry = msg.tokenExpiry || Date.now() + 30 * 24 * 3600 * 1000;
        await saveWithAuth();
        try {
          await tryConnect();
          applyCurrentMedia();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }

      /* Popup: отключить / разорвать соединение */
      case 'DISCONNECT': {
        rpc.disconnect();
        stopDeviceFlow();
        lastDeviceError = '';
        await clearAuth();
        await saveSettings();
        sendResponse({ ok: true });
        break;
      }

      /* Popup: вручную поставить/снять паузу presence */
      case 'TOGGLE_ENABLED': {
        settings.enabled = !settings.enabled;
        await saveSettings();
        if (!settings.enabled) rpc.clearActivity();
        else applyCurrentMedia();
        sendResponse({ ok: true, enabled: settings.enabled });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});

/* ------------------------------------------------------------------ */
/* Выбор активной медиа-вкладки                                          */
/* ------------------------------------------------------------------ */
async function getActiveMediaTab() {
  // 1. Вкладка, которая реально играет (isPlaying === true)
  const playing = Object.entries(tabStates).find(
    ([, s]) => s.isPlaying && isPlatformEnabled(s.platform)
  );
  if (playing) return Number(playing[0]);

  // 2. Иначе — активная таб браузера
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tabStates[tab.id]) return tab.id;

  // 3. Иначе — последняя известная
  const any = Object.keys(tabStates)[0];
  return any ? Number(any) : null;
}

function isPlatformEnabled(platform) {
  return Boolean(settings.platforms[platform]);
}

/* ------------------------------------------------------------------ */
/* Формирование и отправка Presence                                      */
/* ------------------------------------------------------------------ */
function applyCurrentMedia() {
  getActiveMediaTab().then((id) => {
    if (id != null && tabStates[id]) applyMediaState(tabStates[id]);
    else clearPresence();
  });
}

function applyMediaState(state) {
  if (!settings.enabled || !rpc.connected) return;
  if (!state || !isPlatformEnabled(state.platform)) {
    clearPresence();
    return;
  }

  // Скрытие при паузе
  if (!state.isPlaying) {
    if (settings.pauseBehavior === 'hide') {
      clearPresence();
      return;
    }
    if (settings.pauseBehavior === 'showPaused') {
      state = { ...state, paused: true };
    }
  }

  // Приватность: взрослый контент
  if (settings.hideSensitive && state.explicit) {
    clearPresence();
    return;
  }

  lastMediaState = state;

  const activity = buildActivity(state);
  const key = JSON.stringify(activity);
  if (key === lastPresenceKey) return; // без изменений
  lastPresenceKey = key;

  rpc.setActivity(activity);
  updateBadge(state);
}

function buildActivity(state) {
  const isMusic = state.platform === 'soundcloud' || state.platform === 'ytmusic';
  const appName = {
    youtube: 'YouTube',
    ytmusic: 'YouTube Music',
    soundcloud: 'SoundCloud'
  }[state.platform] || 'Media';

  const activity = {
    name: appName,
    // type 2 = Listening, 3 = Watching
    type: isMusic ? 2 : 3,
    platform: appName,
    details: settings.showTitle ? truncate(state.title || 'Что-то смотрю…', 128) : undefined,
    state: undefined,
    assets: {
      large_image: state.artworkUrl || getDefaultAsset(state.platform),
      large_text: truncate(state.title || appName, 128),
      small_image: getSmallIcon(state.platform),
      small_text: state.paused ? 'На паузе' : appName
    },
    buttons: []
  };

  if (settings.showChannel && state.channel) {
    activity.state = truncate(
      state.paused ? `⏸ ${state.channel}` : `${isMusic ? 'by' : 'Канал:'} ${state.channel}`,
      128
    );
  } else if (state.paused) {
    activity.state = 'На паузе';
  }

  // Прогресс: startTimestamp = время начала просмотра
  if (settings.showProgress && typeof state.currentTime === 'number') {
    const now = Date.now();
    activity.startTimestamp = now - state.currentTime * 1000;
    if (typeof state.duration === 'number' && state.duration > 0) {
      activity.endTimestamp = activity.startTimestamp + state.duration * 1000;
    }
  }

  if (settings.showButtons) {
    activity.buttons.push({
      label: isMusic ? 'Слушать' : 'Смотреть',
      url: sanitizeUrl(state.url)
    });
  }

  return activity;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    // Для YouTube критичен параметр v (id видео) — оставляем только его
    if (/youtube/i.test(u.hostname)) {
      const v = u.searchParams.get('v');
      return `https://${u.hostname}${u.pathname}${v ? '?v=' + encodeURIComponent(v) : ''}`;
    }
    u.search = '';
    return u.toString();
  } catch {
    return 'https://discord.com';
  }
}

// Fallback asset keys должны существовать в вашем Discord приложении
function getDefaultAsset(platform) {
  return { youtube: 'youtube_logo', ytmusic: 'ytmusic_logo', soundcloud: 'soundcloud_logo' }[platform] || 'default';
}

function getSmallIcon(platform) {
  return { youtube: 'yt_play', ytmusic: 'ytm_play', soundcloud: 'sc_play' }[platform] || 'default';
}

function clearPresence() {
  lastPresenceKey = '';
  lastMediaState = null;
  if (rpc.connected) rpc.clearActivity();
  updateBadge(null);
}

/* ------------------------------------------------------------------ */
/* Бейдж на иконке расширения — показывает активную платформу           */
/* ------------------------------------------------------------------ */
function updateBadge(state) {
  const text = !state ? '' : state.platform === 'soundcloud' ? 'SC' : state.platform === 'ytmusic' ? 'YM' : 'YT';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state ? '#5865F2' : '#666' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Периодическое обновление (alarms)                                    */
/* ------------------------------------------------------------------ */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'drp-refresh') {
    refreshAccessTokenIfNeeded().catch(() => {});
    // Переоценка состояния (например, если вкладка закрылась или была пауза)
    applyCurrentMedia();
  }
  if (alarm.name === 'drp-reconnect' && !rpc.connected && settings.accessToken && settings.clientId) {
    tryConnect().then(() => applyCurrentMedia()).catch(() => {});
  }
  // Опрос Device Flow — переживает «засыпание» service worker'а
  if (alarm.name === DEVICE_POLL_ALARM) {
    pollDeviceToken().catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* Отслеживание закрытия вкладок                                        */
/* ------------------------------------------------------------------ */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates[tabId]) {
    delete tabStates[tabId];
    applyCurrentMedia();
  }
});
