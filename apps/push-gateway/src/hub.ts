import { createHash } from 'node:crypto';
import type { PushSignal } from '@konsilium/protocol/push';

/** Прямое соединение приложения со шлюзом (поток SSE). */
export interface Connection {
  send(signal: PushSignal): void;
  close(): void;
}

export type DirectResult = 'acked' | 'offline' | 'timeout';

/**
 * Прямые соединения устройств: телефон в сети организации (или в VPN) держит поток к шлюзу и подтверждает каждый
 * сигнал. Ключ — хеш pushkey: сам секрет устройства в памяти шлюза не лежит. Не подтвердило вовремя — соединение
 * считаем оборванным и закрываем (приложение переподключится), а сигнал уходит внешним каналом, если он разрешён.
 *
 * Соединения — в памяти одного процесса. Несколько копий шлюза потребуют общей шины (например, Valkey pub/sub) или
 * балансировки по pushkey.
 */
export class DirectHub {
  private readonly conns = new Map<string, Connection>();
  private readonly pending = new Map<string, { key: string; done: (r: DirectResult) => void }>();

  static key(pushkey: string): string {
    return createHash('sha256').update(pushkey).digest('hex');
  }

  get size(): number {
    return this.conns.size;
  }

  /** Подключить устройство; прежнее соединение того же устройства закрывается. Возвращает функцию отключения. */
  attach(pushkey: string, conn: Connection): () => void {
    const key = DirectHub.key(pushkey);
    const old = this.conns.get(key);
    this.conns.set(key, conn);
    if (old && old !== conn) old.close();
    return () => {
      if (this.conns.get(key) === conn) this.conns.delete(key);
    };
  }

  /** Отправить сигнал и дождаться подтверждения. */
  deliver(pushkey: string, signal: PushSignal, timeoutMs: number): Promise<DirectResult> {
    const key = DirectHub.key(pushkey);
    const conn = this.conns.get(key);
    if (!conn) return Promise.resolve('offline');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(signal.id);
        if (this.conns.get(key) === conn) this.conns.delete(key);
        conn.close();
        resolve('timeout');
      }, timeoutMs);
      this.pending.set(signal.id, {
        key,
        done: (r) => {
          clearTimeout(timer);
          this.pending.delete(signal.id);
          resolve(r);
        },
      });
      try {
        conn.send(signal);
      } catch {
        this.pending.get(signal.id)?.done('offline');
      }
    });
  }

  /** Подтверждение от устройства: засчитывается, только если сигнал был отправлен этому же устройству. */
  ack(pushkey: string, id: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.key !== DirectHub.key(pushkey)) return false;
    p.done('acked');
    return true;
  }
}
