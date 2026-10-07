import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConnectorId, SourceSystem } from '@konsilium/protocol';
import type { UserRef } from '@konsilium/protocol/integration';

/**
 * Подключение — один экземпляр РИС, ЛИС или ТМК, который шлёт события и (на уровне 2) отвечает на обратные вызовы.
 * Токен подключения хранится только как SHA-256. В продукте вместо статических токенов — OAuth 2.0 client credentials
 * (Keycloak) или mTLS; см. docs/10-integration-api.md.
 */
export const ConnectorConfig = z.object({
  id: ConnectorId,
  kind: SourceSystem,
  org: z.string().min(1),
  title: z.string().min(1),
  token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Обратные вызовы (уровень 2): проверка прав, заявки, раскрытие пациента, снимок случая по запросу. */
  callbacks: z
    .object({
      url: z.string().url(),
      token: z.string().min(16),
      timeout_ms: z.number().int().positive().default(3000),
    })
    .optional(),
  /** Как сопоставлять пользователей системы с Matrix ID. В PoC — логин = локальная часть Matrix ID. */
  users: z.object({ strategy: z.literal('login-localpart') }).default({ strategy: 'login-localpart' }),
});
export type Connector = z.infer<typeof ConnectorConfig>;

const File = z.object({ connectors: z.array(ConnectorConfig).min(1) });

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  constructor(connectors: Connector[]) {
    for (const c of connectors) {
      if (this.byId.has(c.id)) throw new Error(`Подключение ${c.id} описано дважды`);
      this.byId.set(c.id, c);
    }
  }

  static parse(raw: unknown): ConnectorRegistry {
    return new ConnectorRegistry(File.parse(raw).connectors);
  }

  static fromFile(path: string): ConnectorRegistry {
    return ConnectorRegistry.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  /** Подключение по токену. Сравнение — по хешам и за постоянное время. */
  authenticate(token: string): Connector | null {
    const hash = sha256(token);
    let found: Connector | null = null;
    for (const c of this.byId.values()) {
      if (timingSafeEqual(hash, Buffer.from(c.token_sha256, 'hex'))) found = c;
    }
    return found;
  }

  get(id: string): Connector | null {
    return this.byId.get(id) ?? null;
  }

  /** Подключение по типу системы — когда клиент знает только «RIS» и подключение такого типа одно. */
  single(kind: SourceSystem): Connector | 'none' | 'ambiguous' {
    const found = [...this.byId.values()].filter((c) => c.kind === kind);
    if (found.length === 0) return 'none';
    return found.length === 1 ? found[0]! : 'ambiguous';
  }

  all(): Connector[] {
    return [...this.byId.values()];
  }
}

/**
 * Сопоставление пользователей системы-источника с Matrix ID.
 * В PoC: `mxid` как есть, иначе `login` → `@login:сервер`. `idp_sub` и `employee_id` требуют справочника
 * (Keycloak, AD) — в продукте здесь запрос к нему.
 */
export class UserResolver {
  constructor(private readonly serverName: string) {}

  toMxid(ref: UserRef): string | null {
    if (ref.mxid) return ref.mxid;
    if (ref.login) {
      const localpart = ref.login.trim().toLowerCase();
      if (/^[a-z0-9._=\-/+]+$/.test(localpart)) return `@${localpart}:${this.serverName}`;
    }
    return null;
  }

  toRef(mxid: string): UserRef {
    const [localpart, server] = [mxid.slice(1, mxid.indexOf(':')), mxid.slice(mxid.indexOf(':') + 1)];
    return server === this.serverName ? { mxid, login: localpart } : { mxid };
  }

  describe(ref: UserRef): string {
    return ref.mxid ?? (ref.login ? `login:${ref.login}` : ref.idp_sub ? 'idp_sub:…' : 'employee_id:…');
  }
}
