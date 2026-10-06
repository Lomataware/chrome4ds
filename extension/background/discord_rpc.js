/**
 * Discord RPC через WebSocket (Gateway) — без нативного клиента.
 * Требует: Client ID приложения Discord + Bot-токен? Нет.
 * Для браузерных расширений используется "Activity Widget SDK" либо приватный Gateway.
 * Здесь реализован рабочий вариант через приватный Discord Gateway с OAuth2 PKCE токеном пользователя.
 */

const GATEWAY_URL = 'wss://gateway.discord.gg/?encoding=json&v=1';

export class DiscordRPC {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.sequence = 0;
    this.heartbeatInterval = null;
    this.accessToken = null;
    this.clientId = null;
    this.currentActivity = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 60000;
  }

  /**
   * Инициализация с токеном доступа (OAuth2, scope: rpc, rpc.notifications.read)
   * @param {string} accessToken - OAuth2 access token пользователя
   * @param {string} clientId - Application ID из Discord Developer Portal
   */
  connect(accessToken, clientId) {
    return new Promise((resolve, reject) => {
      if (this.ws && this.connected) {
        resolve();
        return;
      }
      // Если сокет уже создавался — не пересоздаём (защита от параллельных connect)
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this._pendingResolvers.push({ resolve, reject });
        return;
      }

      this.accessToken = accessToken;
      this.clientId = clientId;
      this._pendingResolvers = this._pendingResolvers || [];

      try {
        this.ws = new WebSocket(GATEWAY_URL);
      } catch (e) {
        reject(e);
        return;
      }

      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };
      this._settleOk = settleOk;
      this._settleErr = settleErr;

      const timeout = setTimeout(() => {
        settleErr(new Error('WebSocket connection timeout'));
        this._cleanupSocket();
        if (this.accessToken) this._scheduleReconnect();
      }, 15000);

      this.ws.onopen = () => {
        console.log('[DRP] WebSocket opened');
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data).catch((err) => settleErr(err));
      };

      this.ws.onerror = (err) => {
        settleErr(err);
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this._stopHeartbeat();
        console.warn('[DRP] WebSocket closed:', event.code, event.reason);
        settleErr(new Error(`Socket closed (${event.code})`));
        // Автопереподключение при нештатном закрытии
        if (event.code !== 1000 && this.accessToken) {
          this._scheduleReconnect();
        }
      };
    });
  }

  async _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const { op, d, s, t } = msg;
    if (s) this.sequence = s;

    switch (op) {
      case 0: // DISPATCH
        await this._handleDispatch(t, d);
        break;
      case 1: // HEARTBEAT
        this._sendHeartbeat();
        break;
      case 7: // RECONNECT
        console.warn('[DRP] Server requested reconnect');
        this._cleanupSocket();
        this._scheduleReconnect();
        break;
      case 9: // INVALID_SESSION
        console.error('[DRP] Invalid session, re-auth required');
        this.connected = false;
        this._stopHeartbeat();
        throw new Error('Invalid session - token may be expired');
      case 10: // HELLO
        this._startHeartbeat(d.heartbeat_interval);
        this._identify();
        break;
      case 11: // HEARTBEAT_ACK
        // console.log('[DRP] Heartbeat ACK');
        break;
    }
  }

  async _handleDispatch(type, data) {
    if (type === 'READY') {
      console.log('[DRP] READY, sending activity');
      this.connected = true;
      this.sessionId = data?.session_id || this.sessionId;
      this.reconnectAttempts = 0;
      // Разрешаем ожидающие connect() промисы
      if (this._settleOk) { this._settleOk(); this._settleOk = null; this._settleErr = null; }
      if (this.currentActivity) {
        this.setActivity(this.currentActivity);
      } else {
        // При отсутствии активности отправляем пустую, чтобы сессия активировалась
        this._sendActivity({ activities: [] });
      }
    }
    if (type === 'RESUMED') {
      this.connected = true;
      if (this._settleOk) { this._settleOk(); this._settleOk = null; this._settleErr = null; }
      if (this.currentActivity) this.setActivity(this.currentActivity);
    }
  }

  _identify() {
    const payload = {
      op: 2,
      d: {
        token: this.accessToken,
        client_id: this.clientId,
        properties: {
          os: 'Windows',
          browser: 'Chrome Extension'
        },
        intents: 0,
        compress: false
      }
    };
    this._send(payload);
  }

  _resume() {
    const payload = {
      op: 6,
      d: {
        token: this.accessToken,
        session_id: this.sessionId || '',
        seq: this.sequence
      }
    };
    this._send(payload);
  }

  _startHeartbeat(intervalMs) {
    this._stopHeartbeat();
    // Первый heartbeat через случайное время
    setTimeout(() => this._sendHeartbeat(), Math.random() * intervalMs);
    this.heartbeatInterval = setInterval(() => this._sendHeartbeat(), intervalMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _sendHeartbeat() {
    this._send({ op: 1, d: this.sequence || null });
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)) + Math.random() * 1000,
      this.maxReconnectDelay
    );
    // В MV3 service worker setTimeout ненадёжен — подстраховываемся alarm'ом
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      chrome.alarms.create('drp-reconnect', { delayInMinutes: delay / 60000 });
    }
    console.log(`[DRP] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.accessToken && !this.connected) {
        this.connect(this.accessToken, this.clientId).catch(() => {});
      }
    }, delay);
  }

  _cleanupSocket() {
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
  }

  disconnect() {
    this.accessToken = null;
    this._cleanupSocket();
  }

  /**
   * Установить Rich Presence активность
   * @param {Object} activity
   * @param {string} activity.details - Первая строка
   * @param {string} activity.state - Вторая строка
   * @param {number} activity.startTimestamp - Unix ms начала
   * @param {number} activity.endTimestamp - Unix ms конца
   * @param {Object} activity.assets - { large_image, large_text, small_image, small_text }
   * @param {Object} activity.buttons - [{label, url}]
   * @param {number} activity.type - 0 = Playing, 2 = Listening, 3 = Watching, 5 = Competing
   * @param {string} activity.platform - YouTube / SoundCloud
   */
  setActivity(activity) {
    this.currentActivity = activity;
    if (!this.connected) return;

    const discordActivity = {
      name: activity.name || 'Discord Media',
      type: activity.type ?? 3,
      application_id: this.clientId,
      details: activity.details || undefined,
      state: activity.state || undefined,
      timestamps: {},
      assets: {},
      buttons: []
    };
    // platform поддерживается не во всех клиентах — добавляем только для music/watch
    if (activity.platform && (activity.type === 2 || activity.type === 3)) {
      discordActivity.platform = activity.platform;
    }

    if (activity.startTimestamp) {
      discordActivity.timestamps.start = Math.floor(activity.startTimestamp / 1000);
    }
    if (activity.endTimestamp) {
      discordActivity.timestamps.end = Math.floor(activity.endTimestamp / 1000);
    }

    if (activity.assets) {
      if (activity.assets.large_image) {
        discordActivity.assets.large_image = activity.assets.large_image;
        discordActivity.assets.large_text = activity.assets.large_text || '';
      }
      if (activity.assets.small_image) {
        discordActivity.assets.small_image = activity.assets.small_image;
        discordActivity.assets.small_text = activity.assets.small_text || '';
      }
    }

    if (Array.isArray(activity.buttons)) {
      // Discord допускает максимум 2 кнопки
      discordActivity.buttons = activity.buttons.slice(0, 2);
    }

    this._sendActivity({ activities: [discordActivity] });
  }

  clearActivity() {
    this.currentActivity = null;
    this._sendActivity({ activities: [] });
  }

  _sendActivity(data) {
    this._send({ op: 3, d: data });
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
