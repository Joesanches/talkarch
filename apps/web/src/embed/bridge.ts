import { envelope, isEnvelope, type ChatEvents, type Envelope, type HostCommands } from '@konsilium/embed/protocol';

type Handler<K extends keyof HostCommands> = (payload: HostCommands[K]) => void | Promise<void>;

/** Команды, которые можно принять до входа пользователя: применятся, когда чат будет готов. */
const DEFERRABLE = new Set<keyof HostCommands>(['context.set', 'unread.watch', 'theme.set', 'room.open', 'auth.token', 'view.visible']);

/**
 * Связь фрейма чата с хостом. Принимает сообщения только от родительского окна и только с разрешённого origin,
 * отвечает ack/error на каждую команду.
 */
export class Bridge {
  private readonly handlers = new Map<string, Handler<never>>();
  private readonly deferred = new Map<string, Envelope>();

  constructor(private readonly hostOrigin: string) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || e.origin !== this.hostOrigin || !isEnvelope(e.data)) return;
      void this.dispatch(e.data);
    });
  }

  private async dispatch(msg: Envelope) {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      if (DEFERRABLE.has(msg.type as keyof HostCommands)) {
        this.deferred.set(msg.type, msg);
        this.reply('ack', {}, msg.id);
      } else {
        this.reply('error', { message: 'Чат ещё не готов: нужен вход пользователя' }, msg.id);
      }
      return;
    }
    try {
      await handler(msg.payload as never);
      this.reply('ack', {}, msg.id);
    } catch (e) {
      this.reply('error', { message: (e as Error).message }, msg.id);
    }
  }

  private reply(type: 'ack' | 'error', payload: unknown, re: string) {
    window.parent.postMessage(envelope(type, payload, re), this.hostOrigin);
  }

  send<K extends keyof ChatEvents>(type: K, payload: ChatEvents[K]) {
    window.parent.postMessage(envelope(type, payload), this.hostOrigin);
  }

  /** Подписка на команду хоста; отложенная команда этого типа применяется сразу. Возвращает отписку. */
  on<K extends keyof HostCommands>(type: K, handler: Handler<K>): () => void {
    this.handlers.set(type, handler as Handler<never>);
    const pending = this.deferred.get(type);
    if (pending) {
      this.deferred.delete(type);
      void Promise.resolve(handler(pending.payload as HostCommands[K])).catch(() => undefined);
    }
    return () => {
      if (this.handlers.get(type) === (handler as Handler<never>)) this.handlers.delete(type);
    };
  }
}

const bridges = new Map<string, Bridge>();

/**
 * Один мост на страницу и origin хоста. Создавать его в рендере React нельзя: строгий режим вызывает
 * useMemo дважды, и второй мост без обработчиков отвечал бы хосту ошибками.
 */
export function bridgeFor(hostOrigin: string): Bridge {
  let b = bridges.get(hostOrigin);
  if (!b) {
    b = new Bridge(hostOrigin);
    bridges.set(hostOrigin, b);
  }
  return b;
}
