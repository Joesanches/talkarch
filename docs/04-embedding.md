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

## 2. Подключение

```html
<script type="module" src="https://chat.clinic.local/embed/v1/embed.js"></script>
<vendor-chat
  mode="panel"
  server="https://chat.clinic.local"
  context-system="RIS"
  context-accession="A26-118734"
  context-study-uid="1.2.643.5.1.13.13.12.2.77.8252.118734"
  theme="host"
  locale="ru">
</vendor-chat>
```

Или программно (npm-пакет, TypeScript):

```ts
import { createChat } from '@vendor/chat-embed';

const chat = await createChat({
  target: document.querySelector('#chat-panel'),   // не нужен для headless
  mode: 'panel',                                    // 'full' | 'panel' | 'launcher' | 'headless'
  server: 'https://chat.clinic.local',
  auth: { kind: 'oidc-silent' },                    // или { kind: 'token', getToken: () => host.getAccessToken() }
  context: { system: 'RIS', accession: 'A26-118734', studyUid: '1.2.643.5.1.13.13.12.2.77.8252.118734' },
  theme: { preset: 'corp', accent: '#1F6FB2', scheme: 'light', density: 'compact' },
  features: { calls: true, voice: true, criticalResults: true },
  locale: 'ru',
});

// Хост → чат
await chat.setContext({ system: 'RIS', accession: 'A26-118739' });   // пользователь открыл другое исследование
await chat.attach({                                                  // кнопка «В чат исследования» во вьюере
  kind: 'key_image',
  studyUid, seriesUid, sopUid, frame: 1,
  presentation: { ww: 700, wc: 100, zoom: 1.4 },
  annotations,
  caption: 'Дефекты наполнения в правой и левой ЛА',
});
await chat.open({ room: 'case', focus: 'composer' });

// Чат → хост
chat.on('ready', () => {});
chat.on('unread', ({ total, byContext }) => worklist.setChatBadges(byContext));
chat.on('critical', ({ context, state }) => worklist.markCritical(context, state));
chat.on('open-link', (link) => {
  if (link.kind === 'dicom') viewer.open(link.studyUid, link.seriesUid, link.sopUid, link.presentation);
  if (link.kind === 'slide') wsiViewer.open(link.slideId, link.region);
  if (link.kind === 'record') host.navigate(link.url);
});
chat.on('auth-required', () => host.reauthenticate());

chat.destroy();
```

Режим `headless` для бейджей в рабочем списке:

```ts
const counters = await createChat({ mode: 'headless', server, auth: { kind: 'oidc-silent' } });
const stop = counters.watchUnread(
  [{ system: 'RIS', accession: 'A26-118734' }, { system: 'RIS', accession: 'A26-118736' }],
  (items) => items.forEach((i) => worklist.setBadge(i.context, i.unread, i.critical)),
);
```

## 3. Протокол между хостом и фреймом

Виджет работает в `iframe` на домене чата: это изоляция хранилища и CSP. Связь — через `postMessage`.

**Конверт:**

```json
{ "proto": "vendor-chat", "v": 1, "id": "c1f9…", "type": "compose.attach", "payload": { } }
```

| Направление | `type` | Назначение |
|---|---|---|
| хост → чат | `context.set` | Сменить контекст (исследование, случай) |
| хост → чат | `compose.attach` | Прикрепить ключевой снимок, ROI или файл |
| хост → чат | `room.open` | Открыть конкретный чат |
| хост → чат | `theme.set` | Передать тему: цвета, схема, плотность |
| хост → чат | `auth.token` | Передать токен (режим `token`) |
| чат → хост | `ready` | Виджет готов |
| чат → хост | `unread.changed` | Счётчики по контекстам |
| чат → хост | `critical.changed` | Статусы критических находок |
| чат → хост | `link.open` | Открыть исследование, стекло или запись в хосте |
| чат → хост | `auth.required` | Нужна повторная аутентификация |
| чат → хост | `resize` | Желаемая высота (`launcher`) |
| оба | `ack` / `error` | Ответ на команду с тем же `id` |

**Безопасность протокола:**

- список разрешённых origin для хоста и чата;
- проверка схемы сообщений;
- игнорирование неизвестных `type`;
- на стороне чата — CSP `frame-ancestors` с доменами хостов.

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
| Глубокие ссылки в приложения | `vendorchat://case/RIS/A26-118734` и универсальная ссылка `https://chat.clinic.local/c/RIS/A26-118734` |

## 6. Тема хоста

Хост передаёт тему: `accent`, `scheme` (`light`/`dark`), `density` (`compact`/`regular`), `radius`. Остальные оттенки чат вычисляет сам по тем же формулам, что и в [дизайн-системе](06-design-system.md). Встроенный чат выглядит частью хоста, а не «чужим окном».

## 7. Версионирование и совместимость

- **Версия протокола** — в конверте (`v`). Изменения только добавочные; несовместимые изменения выходят новой версией с поддержкой предыдущей не меньше двух релизов.
- **SDK** версионируется по SemVer. Встроенный скрипт отдаётся с сервера чата, поэтому обновления чата не требуют релиза хоста.
- **Тестовая страница-песочница** `/embed/playground` эмулирует хост: команды, события, темы.
