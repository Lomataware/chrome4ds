/**
 * Popup / Options скрипт.
 * - Отображает текущий presence и статус подключения.
 * - Управляет настройками.
 * - Реализует Discord OAuth2 Device Flow для получения токена со scope `rpc`.
 */

const $ = (id) => document.getElementById(id);

let settings = null;
let devicePollTimer = null;

/* ------------------------------------------------------------------ */
/* Загрузка состояния                                                   */
/* ------------------------------------------------------------------ */
async function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function init() {
  const status = await sendMessage({ type: 'GET_STATUS' });
  settings = status.settings;

  renderConnection(status);
  renderActivity(status.activity);
  renderSettings(settings);

  $('toggleEnabled').textContent = settings.enabled
    ? '⏸ Приостановить трансляцию статуса'
    : '▶ Возобновить трансляцию статуса';
}

function renderConnection(status) {
  const on = status.connected;
  $('statusDot').classList.toggle('on', on);
  const label = $('connLabel');
  label.textContent = on ? 'подключено' : status.hasToken ? 'переподключение…' : 'не подключено';
  label.className = 'badge ' + (on ? 'badge-on' : 'badge-off');
}

function renderActivity(activity) {
  const box = $('activityPreview');
  if (!activity) {
    box.innerHTML = '<em>Активность не отображается</em>';
    return;
  }
  const time = activity.startTimestamp
    ? formatElapsed(Date.now() - activity.startTimestamp)
    : '';
  box.innerHTML = `
    <div>
      <div class="p-title">${escapeHtml(activity.details || activity.name)}</div>
      <div class="p-sub">${escapeHtml(activity.state || '')}${time ? ' · ⏱ ' + time : ''}</div>
      <div class="p-sub">${typeLabel(activity.type)} · ${escapeHtml(activity.name)}</div>
    </div>`;
}

function typeLabel(t) {
  return { 0: 'Играет в', 2: 'Слушает', 3: 'Смотрит', 5: 'Соревнуется в' }[t] ?? 'Активность';
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}ч ${m % 60}м` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/* ------------------------------------------------------------------ */
/* Рендер настроек                                                      */
/* ------------------------------------------------------------------ */
function renderSettings(s) {
  $('clientId').value = s.clientId || '';
  $('showTitle').checked = s.showTitle;
  $('showChannel').checked = s.showChannel;
  $('showProgress').checked = s.showProgress;
  $('showButtons').checked = s.showButtons;
  $('hideSensitive').checked = s.hideSensitive;
  $('pauseBehavior').value = s.pauseBehavior;
  $('platYoutube').checked = s.platforms.youtube;
  $('platYtmusic').checked = s.platforms.ytmusic;
  $('platSoundcloud').checked = s.platforms.soundcloud;
}

function collectSettings() {
  return {
    clientId: $('clientId').value.trim(),
    showTitle: $('showTitle').checked,
    showChannel: $('showChannel').checked,
    showProgress: $('showProgress').checked,
    showButtons: $('showButtons').checked,
    hideSensitive: $('hideSensitive').checked,
    pauseBehavior: $('pauseBehavior').value,
    platforms: {
      youtube: $('platYoutube').checked,
      ytmusic: $('platYtmusic').checked,
      soundcloud: $('platSoundcloud').checked
    }
  };
}

/* ------------------------------------------------------------------ */
/* Сохранение / управление                                              */
/* ------------------------------------------------------------------ */
$('saveBtn').addEventListener('click', async () => {
  await sendMessage({ type: 'SAVE_SETTINGS', settings: collectSettings() });
  toast('Настройки сохранены ✓');
  init();
});

$('toggleEnabled').addEventListener('click', async () => {
  const res = await sendMessage({ type: 'TOGGLE_ENABLED' });
  $('toggleEnabled').textContent = res.enabled
    ? '⏸ Приостановить трансляцию статуса'
    : '▶ Возобновить трансляцию статуса';
  toast(res.enabled ? 'Статус включён' : 'Статус приостановлен');
});

$('disconnectBtn').addEventListener('click', async () => {
  await sendMessage({ type: 'DISCONNECT' });
  toast('Аккаунт отключён');
  init();
});

$('manualTokenBtn').addEventListener('click', () => {
  $('manualBox').classList.toggle('hidden');
});

$('saveTokensBtn').addEventListener('click', async () => {
  const clientId = $('clientId').value.trim();
  if (!clientId) return toast('Укажите Application ID', true);
  const accessToken = $('accessTokenInput').value.trim();
  if (!accessToken) return toast('Введите access token', true);

  const res = await sendMessage({
    type: 'SET_TOKENS',
    clientId,
    accessToken,
    refreshToken: $('refreshTokenInput').value.trim()
  });
  if (res.ok) {
    toast('Подключено ✓');
    $('manualBox').classList.add('hidden');
    init();
  } else {
    toast('Ошибка подключения: ' + res.error, true);
  }
});

/* ------------------------------------------------------------------ */
/* Discord OAuth2 Device Flow                                           */
/* https://discord.com/developers/docs/topics/oauth2#device-code-grant  */
/* ------------------------------------------------------------------ */
$('authBtn').addEventListener('click', async () => {
  const clientId = $('clientId').value.trim();
  if (!clientId) return toast('Сначала укажите Application ID', true);

  stopDevicePoll();
  $('deviceInfo').classList.remove('hidden');
  $('deviceStatus').textContent = 'Запрос кода…';

  try {
    const res = await fetch('https://discord.com/api/oauth2/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: 'rpc rpc.notifications.read' })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    $('deviceCode').textContent = data.user_code;
    $('deviceUrl').href = data.verification_uri_complete || data.verification_uri;
    window.open(data.verification_uri_complete || data.verification_uri, '_blank');
    $('deviceStatus').textContent = 'Ожидание подтверждения…';

    pollDeviceToken(clientId, data.device_code, data.interval || 5, data.expires_in);
  } catch (e) {
    $('deviceStatus').textContent = 'Не удалось запросить код: ' + e.message;
  }
});

function pollDeviceToken(clientId, deviceCode, intervalSec, expiresIn) {
  const started = Date.now();
  devicePollTimer = setInterval(async () => {
    if (Date.now() - started > expiresIn * 1000) {
      stopDevicePoll();
      $('deviceStatus').textContent = 'Код истёк. Попробуйте ещё раз.';
      return;
    }
    try {
      const res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          scope: 'rpc rpc.notifications.read',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode
        })
      });
      const data = await res.json();

      if (res.ok && data.access_token) {
        stopDevicePoll();
        $('deviceStatus').textContent = 'Готово! Токен получен ✓';
        $('deviceInfo').classList.add('hidden');
        await sendMessage({
          type: 'SET_TOKENS',
          clientId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token || '',
          tokenExpiry: Date.now() + data.expires_in * 1000
        });
        toast('Discord подключён ✓');
        init();
      } else if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        // ждём дальше
      } else if (data.error === 'expired_token') {
        stopDevicePoll();
        $('deviceStatus').textContent = 'Код истёк.';
      } else {
        stopDevicePoll();
        $('deviceStatus').textContent = 'Ошибка: ' + (data.error_description || data.error);
      }
    } catch (e) {
      /* сеть моргнула — продолжаем опрос */
    }
  }, intervalSec * 1000);
}

function stopDevicePoll() {
  if (devicePollTimer) clearInterval(devicePollTimer);
  devicePollTimer = null;
}

/* ------------------------------------------------------------------ */
/* Toast                                                                */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

/* Автообновление превью активности каждые 3 секунды */
setInterval(async () => {
  const status = await sendMessage({ type: 'GET_STATUS' });
  renderConnection(status);
  renderActivity(status.activity);
}, 3000);

init();
