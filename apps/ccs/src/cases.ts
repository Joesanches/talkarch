import { caseKey, type CaseRef, type CaseRole, type SourceSystem } from '@konsilium/protocol';
import type { CaseSnapshot } from '@konsilium/protocol/integration';
import type { Connector, ConnectorRegistry, UserResolver } from './connectors.ts';
import { HostError, type HostCallbacks } from './host.ts';

/** Случай из системы-источника с пользователями, уже сопоставленными с Matrix ID. */
export interface HostCase {
  ref: CaseRef;
  source: SourceSystem;
  snapshot: CaseSnapshot;
  participants: Array<{ userId: string; role: CaseRole }>;
  access: string[];
  revoked: string[];
}

/**
 * Последние снимки случаев. Хранит все случаи, о которых сообщила система-источник, а не только те, где есть чат:
 * чат создаётся лениво, и в момент создания контекст уже должен быть под рукой. В продукте — таблица PostgreSQL.
 */
export interface CaseRegistry {
  get(ref: CaseRef): Promise<HostCase | null>;
  /**
   * Сохранить снимок, если его версия больше сохранённой. Та же версия — `same` (повтор после сбоя: комнату всё равно
   * нужно досинхронизировать), меньшая — `stale`.
   */
  apply(hostCase: HostCase): Promise<{ status: 'accepted' | 'same' | 'stale'; previous: HostCase | null }>;
}

export class InMemoryCaseRegistry implements CaseRegistry {
  private readonly cases = new Map<string, HostCase>();

  async get(ref: CaseRef) {
    return this.cases.get(caseKey(ref)) ?? null;
  }

  async apply(hostCase: HostCase) {
    const key = caseKey(hostCase.ref);
    const previous = this.cases.get(key) ?? null;
    if (previous && previous.snapshot.version > hostCase.snapshot.version) return { status: 'stale' as const, previous };
    if (previous && previous.snapshot.version === hostCase.snapshot.version) return { status: 'same' as const, previous };
    this.cases.set(key, hostCase);
    return { status: 'accepted' as const, previous };
  }
}

/** Поиск случаев и проверка прав: сначала то, что прислала система-источник, затем — её обратные вызовы. */
export class CaseDirectory {
  constructor(
    private readonly deps: {
      registry: CaseRegistry;
      connectors: ConnectorRegistry;
      users: UserResolver;
      callbacksFor: (connector: Connector) => HostCallbacks | null;
    },
  ) {}

  callbacks(connectorId: string): HostCallbacks | null {
    const c = this.deps.connectors.get(connectorId);
    return c ? this.deps.callbacksFor(c) : null;
  }

  /** Снимок → случай с Matrix ID. Пользователей, которых не удалось сопоставить, возвращает в `warnings`. */
  toHostCase(connector: Connector, snapshot: CaseSnapshot): { hostCase: HostCase; warnings: string[] } {
    const warnings: string[] = [];
    const resolve = (u: Parameters<UserResolver['toMxid']>[0]) => {
      const id = this.deps.users.toMxid(u);
      if (!id) warnings.push(`Пользователь ${this.deps.users.describe(u)} не сопоставлен с учётной записью мессенджера`);
      return id;
    };
    const participants = snapshot.participants.flatMap((p) => {
      const userId = resolve(p.user);
      return userId ? [{ userId, role: p.role }] : [];
    });
    const access = (snapshot.access ?? []).flatMap((u) => resolve(u) ?? []);
    const revoked = (snapshot.revoked ?? []).flatMap((u) => resolve(u) ?? []);
    return {
      hostCase: {
        ref: { connector: connector.id, caseId: snapshot.case_id },
        source: connector.kind,
        snapshot,
        participants: participants.filter((p) => !revoked.includes(p.userId)),
        access,
        revoked,
      },
      warnings,
    };
  }

  /** Случай по ссылке. Если события ещё не было, а у подключения есть обратные вызовы, — запрашиваем снимок. */
  async find(ref: CaseRef): Promise<HostCase | null> {
    const known = await this.deps.registry.get(ref);
    if (known) return known;
    const connector = this.deps.connectors.get(ref.connector);
    const callbacks = connector && this.deps.callbacksFor(connector);
    if (!connector || !callbacks) return null;
    const snapshot = await callbacks.getCase(ref.caseId);
    if (!snapshot) return null;
    const { hostCase } = this.toHostCase(connector, snapshot);
    await this.deps.registry.apply(hostCase);
    return (await this.deps.registry.get(ref)) ?? hostCase;
  }

  /**
   * Может ли пользователь открыть чат случая.
   * Отозванным — нет. Участникам и перечисленным в `access` — да. Остальных спрашиваем у системы-источника (уровень 2).
   */
  async canAccess(userId: string, hostCase: HostCase): Promise<boolean> {
    if (hostCase.revoked.includes(userId)) return false;
    if (hostCase.participants.some((p) => p.userId === userId) || hostCase.access.includes(userId)) return true;
    const callbacks = this.callbacks(hostCase.ref.connector);
    if (!callbacks) return false;
    try {
      const r = await callbacks.checkAccess({ case_id: hostCase.snapshot.case_id, user: this.deps.users.toRef(userId) });
      return r.allowed;
    } catch (e) {
      if (e instanceof HostError && e.status === 403) return false;
      throw e;
    }
  }
}
