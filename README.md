# DRP Media — Discord Rich Presence для YouTube, YouTube Music и SoundCloud

Расширение для Google Chrome (Manifest V3), которое в реальном времени отправляет в ваш профиль Discord статус того, что вы смотрите или слушаете:

- ▶ **YouTube** (обычный + Shorts) — «Смотрит …»
- 🎵 **YouTube Music** — «Слушает …»
- ☁️ **SoundCloud** — «Слушает …»

## Возможности

| Функция | Описание |
|---|---|
| Название трека/видео | Первая строка presence (`details`) |
| Канал / исполнитель | Вторая строка (`state`) |
| Прогресс воспроизведения | Таймер «сколько прошло / сколько осталось» (`timestamps`) |
| Обложка | Превью видео/альбома как `large_image` |
| Кнопка со ссылкой | «Смотреть» / «Слушать» — ведёт на видео или трек |
| Мульти-вкладки | Приоритет отдаётся вкладке, которая реально играет |
| Поведение при паузе | Скрывать / показывать «на паузе» / не менять |
| Приватность | Опция скрытия explicit / 18+ контента |
| Тумблер платформ | Можно отключить любую из трёх площадок |
| Бейдж иконки | YT / YM / SC на иконке расширения, когда статус активен |
| Pause/Resume | одной кнопкой в popup без отключения расширения |
| Автопереподключение | Экспоненциальный backoff + восстановление сна Service Worker (MV3) |
| Обновление токена | Автоматический refresh OAuth2 refresh-токена |

## Как это работает

Discord Rich Presence из браузера реализован через **приватный Gateway WebSocket** (`wss://gateway.discord.gg`) с OAuth2 access-токеном пользователя (scope `rpc`). Схема:

```
[Content script: youtube.js / soundcloud.js]
        │  MEDIA_STATE (title, channel, progress, artwork…)
        ▼
[Service Worker] ── формирует Activity ──► [discord_rpc.js] ── op=3 SET_ACTIVITY ──► Discord Gateway
        ▲
[Popup] настройки, Device Flow авторизация
```

## Установка и настройка

### 1. Установка расширения

1. Откройте `chrome://extensions`.
2. Включите **Режим разработчика** (правый верхний угол).
3. Нажмите **«Загрузить распакованное расширение»** и выберите папку `extension/`.

### 2. Создание Discord-приложения (один раз)

1. Зайдите на [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. Скопируйте **Application ID** (General Information).
3. Перейдите в **Rich Presence → Art Assets** и загрузите картинки со следующими ключами (иначе large/small image не отобразятся):
   - `youtube_logo`, `ytmusic_logo`, `soundcloud_logo` — fallback-обложки;
   - `yt_play`, `ytm_play`, `sc_play` — маленькие иконки платформ.
4. Приложение не нужно публиковать — presence работает локально.

### 3. Подключение аккаунта

Откройте popup расширения:

1. Вставьте **Application ID** в поле.
2. Нажмите **«🔗 Получить токен (Device Flow)»** — откроется страница Discord с кодом (`discord.com/activate`). Введите код и подтвердите.
3. Индикатор станет зелёным — подключено ✅.

> Альтернатива: «Ввести токен вручную» — если у вас уже есть access token со scope `rpc` (например, из другого приложения).

### 4. Готово

Включите видео или трек — в течение нескольких секунд в вашем профиле Discord появится статус вида:

```
Смотрит YouTube
Some Awesome Video — Official Clip
Канал: SomeChannel
⏱ 02:31 elapsed · [Смотреть]
```

## Структура проекта

```
extension/
├── manifest.json               # MV3 манифест
├── background/
│   ├── service_worker.js       # координация, настройки, сборка Activity
│   └── discord_rpc.js          # клиент Discord Gateway (WebSocket, heartbeat, reconnect)
├── content/
│   ├── youtube.js              # парсер YouTube / YouTube Music (<video>, DOM, SPA-навигация)
│   └── soundcloud.js           # парсер SoundCloud (MediaSession API + DOM)
├── popup/
│   ├── popup.html/css/js       # настройки + Device Flow авторизация + превью статуса
└── icons/                      # иконки расширения
```

## Известные ограничения

- Discord может ограничивать presence, полученный не из нативного клиента — статус видят друзья в списке, но не всегда в «Activity Feed». Это особенность приватного RPC-API.
- Для работы нужен десктопный/веб-клиент Discord, запущенный под тем же аккаунтом.
- Использование self-bot/OAuth-токена формально не покрывается публичным API Discord — используйте на свой риск для личного применения.
- Контент с DRM-защитой или в Picture-in-Picture иногда не даёт `duration` — тогда показывается только время начала.

## Идеи для развития

- Netflix/Kinopoisk/Spotify Web как дополнительные платформы (достаточно нового content-скрипта).
- История просмотренного (`chrome.storage.local`) со статистикой.
- Синхронизация presence между несколькими браузерами через один Client ID.
- Markdown-шаблоны строк presence (пользовательские форматы `{title} — {channel}`).
