/**
 * SDK встраивания «Консилиума» в РИС, ЛИС и ТМК. Без зависимостей; отдаётся сервером чата: /embed/v1/embed.js.
 *
 *   import { createChat } from 'https://chat.clinic.local/embed/v1/embed.js';
 *   const chat = await createChat({ mode: 'panel', target, server: 'https://chat.clinic.local',
 *                                   context: { connector: 'ris', caseId: 'A26-118734' } });
 *
 * Чат работает во фрейме на домене чата (изоляция хранилища и CSP), связь — postMessage с проверкой origin.
 * Подробности — docs/04-embedding.md.
 */
import {
  envelope,
  isEnvelope,
  contextKey,
  type Attachment,
  type ChatContext,
  type ChatEvents,
  type Envelope,
  type HostCommands,
  type Mode,
  type UnreadItem,
} from './protocol.ts';

export * from './protocol.ts';

export interface CreateChatOptions {
  mode: Mode;
  /** Адрес сервера чата, например https://chat.clinic.local */
  server: string;
  /** Куда поставить панель (режим panel). Для launcher и headless не нужен. */
  target?: HTMLElement;
  context?: ChatContext;
  theme?: { accent?: string };
  /** session — вход во фрейме (или уже выполненный на домене чата); token — токен передаёт хост. */
  auth?: { kind: 'session' } | { kind: 'token'; getToken: () => string | Promise<string> };
  /** Подпись фрейма для экранных дикторов. */
  title?: string;
  launcher?: { label?: string; side?: 'right' | 'left' };
}

export interface ChatHandle {
  readonly mode: Mode;
  readonly frame: HTMLIFrameElement;
  setContext(context: ChatContext): Promise<void>;
  attach(attachment: Attachment): Promise<void>;
  open(options?: { focus?: 'composer' }): Promise<void>;
  setTheme(theme: { accent?: string }): Promise<void>;
  /** Счётчики непрочитанного по контекстам (бейджи рабочего списка). Возвращает функцию отписки. */
  watchUnread(contexts: ChatContext[], callback: (items: UnreadItem[], total: number) => void): () => void;
  on<E extends keyof ChatEvents>(event: E, callback: (payload: ChatEvents[E]) => void): () => void;
  destroy(): void;
}

const ACK_TIMEOUT_MS = 15_000;

function frameUrl(o: CreateChatOptions): string {
  const url = new URL('/embed', o.server);
  url.searchParams.set('mode', o.mode);
  url.searchParams.set('host', location.origin);
  if (o.context?.connector) url.searchParams.set('connector', o.context.connector);
  if (o.context?.system) url.searchParams.set('system', o.context.system);
  if (o.context?.caseId) url.searchParams.set('caseId', o.context.caseId);
  if (o.theme?.accent) url.searchParams.set('accent', o.theme.accent.replace(/^#/, ''));
  return url.toString();
}

/** Кнопка и окно режима launcher — в Shadow DOM, чтобы стили хоста их не задевали. */
function mountLauncher(frame: HTMLIFrameElement, o: CreateChatOptions) {
  const host = document.createElement('div');
  host.setAttribute('data-konsilium-launcher', '');
  const root = host.attachShadow({ mode: 'open' });
  const side = o.launcher?.side ?? 'right';
  const accent = o.theme?.accent ?? '#1F6FB2';
  root.innerHTML = `
    <style>
      :host { all: initial; }
      button { position: fixed; ${side}: 24px; bottom: 24px; width: 56px; height: 56px; border-radius: 50%; border: 0;
        background: ${accent}; color: #fff; cursor: pointer; box-shadow: 0 6px 20px rgb(0 0 0 / .2); z-index: 2147483000;
        display: grid; place-items: center; }
      button:focus-visible { outline: 3px solid ${accent}; outline-offset: 3px; }
      .badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
        background: #C62828; color: #fff; font: 600 12px/20px system-ui, sans-serif; display: none; }
      .badge.on { display: block; }
      .popup { position: fixed; ${side}: 24px; bottom: 92px; width: min(420px, calc(100vw - 32px)); height: min(640px, calc(100vh - 120px));
        border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgb(0 0 0 / .25); background: #fff; z-index: 2147483000; display: none; }
      .popup.open { display: block; }
      .popup ::slotted(iframe) { width: 100%; height: 100%; border: 0; }
    </style>
    <div class="popup" part="popup"><slot></slot></div>
    <button type="button" part="button" aria-label="${o.launcher?.label ?? 'Чат случая'}" aria-expanded="false">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>
      <span class="badge"></span>
    </button>`;
  frame.style.cssText = 'width:100%;height:100%;border:0';
  host.append(frame);
  document.body.append(host);
  const button = root.querySelector('button')!;
  const popup = root.querySelector('.popup')!;
  const badge = root.querySelector('.badge')!;
  button.addEventListener('click', () => {
    const open = popup.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
  return {
    element: host,
    setBadge(n: number) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('on', n > 0);
    },
  };
}

export function createChat(options: CreateChatOptions): Promise<ChatHandle> {
  const chatOrigin = new URL(options.server).origin;
  const frame = document.createElement('iframe');
  frame.src = frameUrl(options);
  frame.title = options.title ?? (options.mode === 'headless' ? 'Счётчики чата' : 'Чат исследования');
  frame.allow = 'camera; microphone; display-capture; autoplay; clipboard-write';

  let launcher: ReturnType<typeof mountLauncher> | null = null;
  if (options.mode === 'panel') {
    if (!options.target) throw new Error('createChat: для режима panel нужен target');
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    options.target.append(frame);
  } else if (options.mode === 'launcher') {
    launcher = mountLauncher(frame, options);
  } else {
    // Невидимый, но не display:none — чтобы браузер не притормаживал фрейм.
    frame.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    (options.target ?? document.body).append(frame);
  }

  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  let watched: Set<string> | null = null;

  const emit = (type: string, payload: unknown) => listeners.get(type)?.forEach((cb) => cb(payload));

  function onMessage(e: MessageEvent) {
    // Только наш фрейм и только с домена чата.
    if (e.source !== frame.contentWindow || e.origin !== chatOrigin || !isEnvelope(e.data)) return;
    const msg = e.data as Envelope;
    if (msg.type === 'ack' || msg.type === 'error') {
      const p = msg.re ? pending.get(msg.re) : undefined;
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.re!);
        if (msg.type === 'ack') p.resolve();
        else p.reject(new Error((msg.payload as { message?: string })?.message ?? 'Ошибка чата'));
      }
      if (msg.type === 'error' && !p) emit('error', msg.payload);
      return;
    }
    if (msg.type === 'ready') {
      markReady();
      if (options.auth?.kind === 'token') void Promise.resolve(options.auth.getToken()).then((t) => post('auth.token', { accessToken: t }));
      if (watched) void post('unread.watch', { contexts: [...watched].map((k) => ({ connector: k.split(':')[0]!, caseId: k.slice(k.indexOf(':') + 1) })) });
    }
    if (msg.type === 'auth.required' && options.auth?.kind === 'token') {
      void Promise.resolve(options.auth.getToken()).then((t) => post('auth.token', { accessToken: t }));
    }
    if (msg.type === 'unread.changed') launcher?.setBadge((msg.payload as ChatEvents['unread.changed']).total);
    emit(msg.type, msg.payload);
  }
  window.addEventListener('message', onMessage);

  async function post<K extends keyof HostCommands>(type: K, payload: HostCommands[K]): Promise<void> {
    await ready;
    const msg = envelope(type, payload);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        reject(new Error(`Чат не ответил на ${type}`));
      }, ACK_TIMEOUT_MS);
      pending.set(msg.id, { resolve, reject, timer });
      frame.contentWindow?.postMessage(msg, chatOrigin);
    });
  }

  const handle: ChatHandle = {
    mode: options.mode,
    frame,
    setContext: (context) => post('context.set', context),
    attach: (attachment) => post('compose.attach', attachment),
    open: (o = {}) => post('room.open', o),
    setTheme: (theme) => post('theme.set', theme),
    watchUnread(contexts, callback) {
      watched = new Set(contexts.filter((c) => c.connector).map((c) => contextKey(c.connector!, c.caseId)));
      void post('unread.watch', { contexts });
      return handle.on('unread.changed', (p) => {
        const items = p.byContext.filter((i) => watched?.has(contextKey(i.connector, i.caseId)));
        callback(items, items.reduce((s, i) => s + i.unread, 0));
      });
    },
    on(event, callback) {
      const set = listeners.get(event) ?? new Set();
      set.add(callback as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(callback as (p: unknown) => void);
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      listeners.clear();
      launcher?.element.remove();
      frame.remove();
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Чат на ${chatOrigin} не ответил`)), 30_000);
    void ready.then(() => {
      clearTimeout(timer);
      resolve(handle);
    });
  });
}

/**
 * Веб-компонент для подключения без JavaScript-кода:
 *   <konsilium-chat server="https://chat.clinic.local" context-connector="ris" context-case-id="A26-118734"></konsilium-chat>
 */
if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined' && !customElements.get('konsilium-chat')) {
  customElements.define(
    'konsilium-chat',
    class extends HTMLElement {
      handle: ChatHandle | null = null;
      connectedCallback() {
        const caseId = this.getAttribute('context-case-id');
        const accent = this.getAttribute('accent');
        void createChat({
          mode: (this.getAttribute('mode') as Mode | null) ?? 'panel',
          server: this.getAttribute('server') ?? location.origin,
          target: this,
          context: caseId ? { connector: this.getAttribute('context-connector') ?? undefined, caseId } : undefined,
          theme: accent ? { accent } : undefined,
        }).then((h) => {
          this.handle = h;
          this.dispatchEvent(new CustomEvent('ready', { detail: h }));
        });
      }
      disconnectedCallback() {
        this.handle?.destroy();
        this.handle = null;
      }
    },
  );
}
