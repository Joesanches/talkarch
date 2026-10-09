# SDK встраивания в РИС, ЛИС и ТМК

Цель — встроить чат в любой веб-интерфейс компании (РИС, ЛИС, ТМК, МИС) за несколько строк кода. Встроенный чат:

- работает в контексте открытого исследования или случая;
- использует вход хоста;
- берёт тему хоста;
- обменивается с хостом командами: «прикрепить снимок», «открыть во вьюере», «сколько непрочитанных по строкам рабочего списка».

## 1. Режимы

| Режим | UI | Типичное место | Макет |
|---|---|---|---|
| `panel` | Панель 360–480 px рядом с основным содержимым | Вьюер РИС, карточка случая | «Встраивание в РИС» |
| `launcher` | Плавающая кнопка с бейджем и всплывающее окно чата | Формы ЛИС, МИС | «Встраивание в ЛИС» |
| `full` | Полное приложение во вкладке или фрейме | Любая система | «Десктоп» |
| `headless` | Без UI: счётчики, события, уведомления | Рабочие списки, шапка хоста | Бейджи в рабочем списке РИС |

Все режимы — один и тот же веб-клиент, поэтому поведение и дизайн одинаковы везде.

> **Статус PoC (08.10.2026).** Работают режимы `panel`, `launcher` и `headless`, функция `createChat()`, элемент `<konsilium-chat>` и протокол v1 (`packages/embed/src/protocol.ts`). Режим `full` — обычный веб-клиент по ссылке `/c/{подключение}/{номер}`. Живые примеры в песочнице (`http://localhost:8090/demo/…` в окружении разработчика, `https://<стенд>/sandbox/…` на стенде):
>
> - **демо-РИС** (`ris`) — рабочий список с бейджами, вьюер с кнопкой «В чат исследования» и панель чата (`panel`);
> - **демо-ЛИС** (`lis`) — форма случая патоморфологии с плавающим чатом (`launcher`) и кнопкой «В чат» у стекла: препарат уходит в чат карточкой с миниатюрой, «Открыть во вьюере» в чате открывает стекло в ЛИС. На кнопке — бейдж непрочитанного; пока окно свёрнуто, чат не отмечает сообщения прочитанными, а при открытии показывает разделитель «Непрочитанные сообщения».
> Вход: в PoC — во фрейме или токеном от хоста (`auth.token`); единый вход через Keycloak (`oidc-silent`) — после подключения Keycloak.

## 2. Подключение

```html
<script type="module" src="https://chat.clinic.local/embed/v1/embed.js"></script>
<konsilium-chat
  mode="panel"
  server="https://chat.clinic.local"
  context-connector="ris"
  context-case-id="A26-118734"
  accent="#1F6FB2">
</konsilium-chat>
```

`connector` — идентификатор подключения РИС/ЛИС в «Консилиуме», `caseId` — номер случая или исследования в ней. Если подключение такого типа в организации одно, можно передать `system: 'RIS'` вместо `connector`. Серверная сторона интеграции — в [10-integration-api.md](10-integration-api.md).

Или программно (npm-пакет, TypeScript):

```ts
import { createChat } from 'https://chat.clinic.local/embed/v1/embed.js';   // или пакет @konsilium/embed

const chat = await createChat({
  target: document.querySelector('#chat-panel'),   // не нужен для headless
  mode: 'panel',                                    // 'full' | 'panel' | 'launcher' | 'headless'
  server: 'https://chat.clinic.local',
  auth: { kind: 'oidc-silent' },                    // или { kind: 'token', getToken: () => host.getAccessToken() }
  context: { connector: 'ris', caseId: 'A26-118734', studyUid: '1.2.643.5.1.13.13.12.2.77.8252.118734' },
  theme: { preset: 'corp', accent: '#1F6FB2', scheme: 'light', density: 'compact' },
  features: { calls: true, voice: true, criticalResults: true },
  locale: 'ru',
});

// Хост → чат
await chat.setContext({ connector: 'ris', caseId: 'A26-118739' });   // пользователь открыл другое исследование
await chat.attach({                                                  // кнопка «В чат исследования» во вьюере
  kind: 'key_image',
  studyUid, seriesUid, sopUid, frame: 1,
  presentation: { ww: 700, wc: 100, zoom: 1.4 },
  annotations,
  caption: 'Дефекты наполнения в правой и левой ЛА',
});
await chat.attach({                                                  // кнопка «В чат» у стекла в ЛИС
  kind: 'slide_roi',
  slideId: '2', block: '1Б', stain: 'H&E', magnification: 20,
  region: { x: 13824, y: 8400, w: 2048, h: 2048, level: 0 },          // без области — всё стекло
  thumbnail: 'data:image/png;base64,…',
});
await chat.open({ room: 'case', focus: 'composer' });                // в режиме launcher — и открыть окно

// Чат → хост
chat.on('ready', () => {});
chat.on('unread', ({ total, byContext }) => worklist.setChatBadges(byContext));
chat.on('critical', ({ context, state }) => worklist.markCritical(context, state));
chat.on('open-link', (link) => {
  if (link.kind === 'dicom') viewer.open(link.studyUid, link.seriesUid, link.sopUid, link.presentation);
  if (link.kind === 'slide') wsiViewer.open(link.slideId, link.region);       // стекло: stain, magnification, region
  if (link.kind === 'record') host.navigate(link.url);
});
chat.on('auth-required', () => host.reauthenticate());

chat.destroy();
```

Режим `headless` для бейджей в рабочем списке:

```ts
const counters = await createChat({ mode: 'headless', server, auth: { kind: 'oidc-silent' } });
const stop = counters.watchUnread(
  [{ connector: 'ris', caseId: 'A26-118734' }, { connector: 'ris', caseId: 'A26-118736' }],
  (items) => items.forEach((i) => worklist.setBadge(i.context, i.unread, i.critical)),
);
```

## 3. Протокол между хостом и фреймом

Виджет работает в `iframe` на домене чата: это изоляция хранилища и CSP. Связь — через `postMessage`.

**Конверт:**

```json
{ "proto": "konsilium-chat", "v": 1, "id": "c1f9…", "type": "compose.attach", "payload": { } }
```

| Направление | `type` | Назначение | PoC |
|---|---|---|---|
| хост → чат | `context.set` | Сменить контекст (исследование, случай) | ✓ |
| хост → чат | `compose.attach` | Прикрепить ключевой снимок (`key_image`: миниатюра, кадр, окно) или препарат (`slide_roi`: стекло, блок, окраска, увеличение, область, миниатюра) | ✓ |
| хост → чат | `room.open` | Поставить курсор в поле ввода | ✓ |
| хост → чат | `theme.set` | Передать цвет бренда; остальные оттенки чат вычисляет сам | ✓ |
| хост → чат | `auth.token` | Передать токен (режим `token`) | ✓ |
| хост → чат | `unread.watch` | Какие контексты считать (строки рабочего списка) | ✓ |
| хост → чат | `view.visible` | Окно `launcher` открыто или свёрнуто (SDK шлёт сам); свёрнутый чат не отмечает сообщения прочитанными | ✓ |
| чат → хост | `ready` | Виджет готов | ✓ |
| чат → хост | `context.opened` | Чат случая открыт | ✓ |
| чат → хост | `unread.changed` | Счётчики по контекстам; новые приглашения — отдельным признаком; `critical` — сколько критических находок ждут подтверждения пользователя (хост показывает красный «!») | ✓ |
| чат → хост | `link.open` | Открыть исследование (`dicom`: серия, кадр, окно), стекло (`slide`: окраска, увеличение, область), запись или ссылку в хосте | ✓ |
| чат → хост | `view.minimize` | Пользователь свернул окно кнопкой в заголовке чата (`launcher`; SDK закрывает окно сам) | ✓ |
| чат → хост | `auth.required` | Нужен вход | ✓ |
| чат → хост | `critical.changed` | Статусы критических находок | план |
| чат → хост | `resize` | Желаемая высота (`launcher`) | план |
| оба | `ack` / `error` | Ответ на команду с тем же `id` | ✓ |

**Безопасность протокола:**

- **Чат принимает команды** только от родительского окна и только с origin, разрешённого в `config.json` (`embedOrigins`; свой домен разрешён всегда). На чужой странице фрейм показывает «встраивание не разрешено» и не отвечает.
- **SDK принимает события** только от своего фрейма и только с домена чата.
- **Сообщения проверяются по форме** конверта, неизвестные `type` игнорируются. На каждую команду приходит `ack` или `error`.
- **CSP `frame-ancestors`** на сервере чата ограничивает, кто может показать чат во фрейме (на стенде — `EMBED_ORIGINS`).
- **Медиа** (миниатюры снимков) загружаются на сервер сообщений и показываются только с токеном (authenticated media).

## 4. Аутентификация

| Вариант | Когда | Как |
|---|---|---|
| `oidc-silent` (рекомендуется) | Хост и чат входят через один Keycloak | Виджет выполняет OIDC-авторизацию с `prompt=none` и PKCE. Пользователь уже вошёл в РИС — повторного входа нет |
| `token` | У хоста свой IdP или нужна явная передача | Хост передаёт короткоживущий токен (`auth.token`). Сервер обменивает его на сессию: RFC 8693 token exchange в Keycloak или JWT-вход Synapse |

**Сторонние cookie.** Браузеры ограничивают cookie во фреймах на чужих доменах. Поэтому:

- лучше размещать чат на том же регистрируемом домене, что и хост (`ris.clinic.local` и `chat.clinic.local`);
- если не получается — использовать режим `token` без cookie.

## 5. Ссылки и стандарты

| Что | Стандарт или механизм |
|---|---|
| Открыть исследование во вьюере | IHE Invoke Image Display (IID) |
| Открыть конкретный кадр или ROI | Шаблон URL вьюера (настраивается для каждого вьюера); для WSI — координаты и уровень |
| Превью снимка | DICOMweb WADO-RS `/rendered`, `/thumbnail` |
| Сохранить ключевые снимки в PACS | DICOM Key Object Selection (KOS) через STOW-RS; в FHIR R5 — `ImagingSelection` |
| Цифровая патология | DICOM WSI (Supplement 145), IHE PaLM |
| Контекст исследования и заказа | FHIR R4: `ServiceRequest`, `ImagingStudy`, `DiagnosticReport`, `Specimen`; события — FHIR Subscriptions или HL7 v2 (ORM/ORU/ADT) |
| Запуск во внешних МИС | SMART App Launch (передача пациента и контекста из МИС) |
| Глубокие ссылки в приложения | `vendorchat://case/ris/A26-118734` и универсальная ссылка `https://chat.clinic.local/c/ris/A26-118734` (`/c/{подключение}/{номер случая}`) |

## 6. Тема хоста

Хост передаёт тему: `accent`, `scheme` (`light`/`dark`), `density` (`compact`/`regular`), `radius`. Остальные оттенки чат вычисляет сам по тем же формулам, что и в [дизайн-системе](06-design-system.md). Встроенный чат выглядит частью хоста, а не «чужим окном».

## 7. Версионирование и совместимость

- **Версия протокола** — в конверте (`v`). Изменения только добавочные; несовместимые изменения выходят новой версией с поддержкой предыдущей не меньше двух релизов.
- **SDK** версионируется по SemVer. Встроенный скрипт отдаётся с сервера чата, поэтому обновления чата не требуют релиза хоста.
- **Тестовая страница-песочница** `/embed/playground` эмулирует хост: команды, события, темы.
