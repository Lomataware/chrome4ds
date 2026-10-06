/**
 * Popup / Options скрипт.
 * - Отображает текущий presence и статус подключения.
 * - Управляет настройками.
 * - Реализует Discord OAuth2 Device Flow для получения токена со scope `rpc`.
 */

const $ = (id) => document.getElementById(id);

let settings = null;

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
/* Discord OAuth2 Device Flow — запуск через background                 */
/*                                                                      */
/* Раньше запрос шёл напрямую из popup и страница discord.com/activate  */
/* не открывалась. Причины, которые устранены:                         */
/*  1) window.open() из popup прерывается, т.к. popup закрывается при   */
/*     потере фокуса — теперь вкладку открывает service worker          */
/*     (chrome.tabs.create).                                            */
/*  2) fetch к discord.com из popup блокировался CORS — теперь запросы  */
/*     идут из background, покрытого host_permissions.                  */
/*  3) Ошибки API были неинформативны («Failed to fetch») — теперь      */
/*     показывается текст от Discord + подсказки (см. buildDiscordError)*/
/*  4) Опрос токена живёт в chrome.alarms и переживает закрытие popup   */
/*     и «засыпание» MV3 service worker.                                */
/* ------------------------------------------------------------------ */

let deviceStatusTimer = null;

$('authBtn').addEventListener('click', async () => {
  const clientId = $('clientId').value.trim();
  if (!clientId) return toast('Сначала укажите Application ID', true);

  stopDevicePoll();
  $('deviceInfo').classList.remove('hidden');
  $('deviceStatus').textContent = 'Запрос кода…';
  $('authBtn').disabled = true;

  try {
    const res = await sendMessage({ type: 'START_DEVICE_FLOW', clientId });
    if (!res || !res.ok) throw new Error((res && res.error) || 'background не ответил');

    $('deviceCode').textContent = res.userCode;
    $('deviceUrl').href = res.verificationUri;
    $('deviceStatus').textContent =
      'Вкладка Discord открыта автоматически. Подтвердите доступ — статус обновится сам.';
    startDeviceStatusPoll(); // на случай, если popup закрыли и открыли заново
  } catch (e) {
    $('deviceStatus').innerHTML =
      `Не удалось запросить код: <b>${escapeHtml(e.message)}</b><br>` +
      '<span class="muted">Частые причины: неверный Application ID, Discord-приложение без включённого RPC, ' +
      'расширение не перезагружено после обновления (chrome://extensions → ⟳), блокировка запроса антивирусом/прокси.</span>';
  } finally {
    $('authBtn').disabled = false;
  }
});

/* Копирование кода в буфер обмена по клику */
$('deviceCode').addEventListener('click', async () => {
  const code = $('deviceCode').textContent.trim();
  if (!code || code === '------') return;
  try {
    await navigator.clipboard.writeText(code);
    toast('Код скопирован ✓');
  } catch (e) {
    /* буфер обмена недоступен — просто выделяем текст */
  }
});

/* Если Device Flow уже запущен в background — восстанавливаем UI опроса */
async function restoreDeviceFlowUi() {
  const st = await sendMessage({ type: 'DEVICE_FLOW_STATUS' });
  if (!st || !st.ok) return;
  if (st.active) {
    $('deviceInfo').classList.remove('hidden');
    $('deviceStatus').textContent = 'Ожидание подтверждения в Discord…';
    startDeviceStatusPoll();
  } else if (st.error) {
    $('deviceInfo').classList.remove('hidden');
    $('deviceStatus').textContent = st.error;
  }
}

/* Раз в 2 с спрашиваем background: получил ли он токен? */
function startDeviceStatusPoll() {
  stopDevicePoll();
  deviceStatusTimer = setInterval(async () => {
    try {
      const st = await sendMessage({ type: 'DEVICE_FLOW_STATUS' });
      if (!st) return;
      if (!st.active && st.hasToken) {
        stopDevicePoll();
        $('deviceInfo').classList.add('hidden');
        toast(st.connected ? 'Discord подключён ✓' : 'Токен получен, но RPC-подключение не установлено');
        init();
      } else if (!st.active && st.error) {
        stopDevicePoll();
        $('deviceStatus').textContent = st.error;
      }
    } catch (e) { /* SW мог уснуть — попробуем в следующий тик */ }
  }, 2000);
}

function stopDevicePoll() {
  if (deviceStatusTimer) clearInterval(deviceStatusTimer);
  deviceStatusTimer = null;
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
restoreDeviceFlowUi();
