/**
 * ИИ-«Секретарь»: стенограмма звонка и черновик протокола консилиума (docs/08-video-ai.md, 5.1 и 5.4).
 *
 * Сервис контекста запускает агента (apps/secretary) по кнопке участника, показывает всем индикатор,
 * принимает стенограмму и готовит черновик: через LLM (OpenAI-совместимый ИИ-шлюз) или, если её нет, по шаблону.
 * Пациент, случай, состав и время — из систем, не от ИИ. Каждое утверждение черновика ссылается на фрагменты стенограммы.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  CallState,
  CaseContext,
  DraftStatement,
  EventType,
  MsgType,
  ProtocolDraft,
  TranscriptSegment,
  type CaseRolesContent,
  type TranscriptMessage,
} from '@konsilium/protocol';
import type { CallTokenService } from './calls.ts';
import { ForbiddenError } from './calls.ts';
import type { Logger } from './events.ts';
import { roleName } from './labels.ts';
import type { MatrixApi } from './matrix.ts';

export type AiProfile = 'off' | 'gpu' | 'cpu' | 'external';

/** Результат агента: POST /internal/v1/secretary/sessions/{id}/result. */
export const SecretaryResult = z.object({
  session_id: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  participants: z.array(z.object({ identity: z.string(), name: z.string() })).default([]),
  segments: z.array(TranscriptSegment),
  asr: z.object({ engine: z.string() }),
});
export type SecretaryResult = z.infer<typeof SecretaryResult>;

type Sections = ProtocolDraft[typeof MsgType.Report]['sections'];

export interface LlmClient {
  readonly model: string;
  complete(system: string, user: string): Promise<string>;
}

/** LLM через OpenAI-совместимый API (llama.cpp, vLLM, Docker Model Runner, ИИ-шлюз организации). */
export class OpenAiCompatibleLlm implements LlmClient {
  constructor(
    private readonly url: string,
    readonly model: string,
    private readonly timeoutMs = 300_000,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 1200,
        // Ответ строго JSON (грамматика в llama.cpp, vLLM; json mode у шлюзов OpenAI-совместимого API).
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM ответила ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }
}

const LlmSections = z.object({
  purpose: z.array(DraftStatement).default([]),
  clinical: z.array(DraftStatement).default([]),
  discussion: z.array(DraftStatement).default([]),
  decision: z.array(DraftStatement).default([]),
  dissent: z.array(DraftStatement).default([]),
});

export const SYSTEM_PROMPT = `Ты помогаешь секретарю врачебного консилиума оформить черновик протокола по стенограмме.
Правила:
- Используй только то, что сказано в стенограмме. Ничего не придумывай: ни диагнозов, ни данных пациента, ни решений.
- Каждое утверждение сопровождай номерами фрагментов стенограммы, на которых оно основано (поле refs).
- Не указывай ФИО и другие данные пациента — их подставит система.
- Если для раздела в стенограмме ничего нет — пустой массив.
- Пиши по-русски, кратко, в деловом стиле. Повторы объединяй.
Разделы:
- purpose — зачем собрали консилиум, если это прозвучало;
- clinical — клинические данные и результаты исследований, которые назвали участники;
- discussion — позиция каждого участника кратко, его имя в speaker;
- decision — что предложено и принято: лечение, исследования, сроки;
- dissent — несогласие участника с решением, его имя в speaker.
Пример.
Стенограмма:
[0] Иванов И. И. (рентгенолог): на томограмме очаг в правом лёгком двенадцать миллиметров
[1] Петров П. П. (лечащий врач): предлагаю биопсию под контролем томографии
[2] Иванов И. И. (рентгенолог): согласен
Ответ:
{"purpose":[],"clinical":[{"text":"На томограмме очаг в правом лёгком 12 мм","refs":[0]}],"discussion":[{"speaker":"Иванов И. И.","text":"Описал очаг в правом лёгком, согласен с биопсией","refs":[0,2]},{"speaker":"Петров П. П.","text":"Предложил биопсию под контролем томографии","refs":[1]}],"decision":[{"text":"Биопсия под контролем томографии","refs":[1,2]}],"dissent":[]}
Ответ — только JSON без пояснений, в том же формате.
/no_think`;

/** Основы значимых слов (первые 5 букв слов от 4 букв): грубая, но независимая от модели сверка со стенограммой. */
function stems(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\d]+/gu) ?? []).filter((w) => w.length >= 4 || /\d/.test(w)).map((w) => w.slice(0, 5));
}

/**
 * Утверждение подтверждено, если хотя бы половина его значимых слов есть во фрагментах, на которые оно ссылается.
 * Отсекает «пересказ» того, чего на консилиуме не говорили, даже когда модель поставила ссылку.
 */
export function grounded(text: string, quoted: string[]): boolean {
  const own = stems(text);
  if (!own.length) return false;
  const pool = new Set(quoted.flatMap(stems));
  return own.filter((w) => pool.has(w)).length / own.length >= 0.5;
}

/** Первый целый JSON-объект в тексте: модель может добавить пояснения до и после, а то и второй объект. */
export function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** Разбор ответа LLM: JSON (возможно, в ```-блоке и после <think>), проверка схемы, ссылок и опоры на стенограмму. */
export function parseLlmSections(text: string, segments: TranscriptSegment[]): Sections | null {
  const parsed = LlmSections.safeParse(firstJsonObject(text.replace(/<think>[\s\S]*?<\/think>/g, '')));
  if (!parsed.success) return null;
  const byIndex = new Map(segments.map((s) => [s.i, s]));
  // Утверждение без подтверждения фрагментом стенограммы в черновик не попадает; одинаковые — склеиваются.
  const keep = (items: DraftStatement[]) => {
    const out: DraftStatement[] = [];
    for (const raw of items) {
      let refs = [...new Set(raw.refs.filter((r) => byIndex.has(r)))].sort((a, b) => a - b);
      // Позиция участника опирается только на его собственные реплики: атрибуция по дорожкам точная, модель — нет.
      const speaker = raw.speaker?.trim();
      if (speaker) refs = refs.filter((r) => byIndex.get(r)!.name === speaker);
      const s = { ...raw, ...(speaker ? { speaker } : {}), text: raw.text.trim(), refs };
      if (!s.text || !refs.length || !grounded(s.text, refs.map((r) => byIndex.get(r)!.text))) continue;
      const same = out.find((o) => o.text === s.text && o.speaker === s.speaker);
      if (same) same.refs = [...new Set([...same.refs, ...refs])].sort((a, b) => a - b);
      else out.push(s);
    }
    return out;
  };
  const sections: Sections = {
    purpose: keep(parsed.data.purpose),
    clinical: keep(parsed.data.clinical),
    discussion: keep(parsed.data.discussion),
    decision: keep(parsed.data.decision),
    dissent: keep(parsed.data.dissent),
  };
  return Object.values(sections).some((v) => v.length) ? sections : null;
}

/** Черновик без LLM: позиции участников — подряд идущие реплики говорящего; решение заполняет врач. */
export function templateSections(segments: TranscriptSegment[]): Sections {
  const discussion: DraftStatement[] = [];
  for (const s of segments) {
    const last = discussion.at(-1);
    if (last && last.speaker === s.name) {
      last.text = `${last.text} ${s.text}`;
      last.refs.push(s.i);
    } else {
      discussion.push({ speaker: s.name, text: s.text, refs: [s.i] });
    }
  }
  return { purpose: [], clinical: [], discussion, decision: [], dissent: [] };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

/** Текст черновика для любых Matrix-клиентов (`body`). */
export function protocolBody(draft: ProtocolDraft[typeof MsgType.Report]): string {
  const lines = [
    'ЧЕРНОВИК ПРОТОКОЛА КОНСИЛИУМА (ИИ) — проверьте перед принятием',
    `Дата: ${draft.meeting.date}, ${draft.meeting.start}–${draft.meeting.end}, ${draft.meeting.form === 'remote' ? 'дистанционно' : 'очно'}`,
  ];
  if (draft.case) lines.push(`Случай: ${draft.case.case_id} · ${draft.case.title} · пациент ${draft.case.patient}`);
  lines.push(`Состав: ${draft.participants.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ') || '—'}`);
  const section = (title: string, items: DraftStatement[]) => {
    if (!items.length) return lines.push(`${title}: —`);
    lines.push(`${title}:`);
    for (const it of items) lines.push(`— ${it.speaker ? `${it.speaker}: ` : ''}${it.text}${it.refs.length ? ` [${it.refs.join(', ')}]` : ''}`);
  };
  section('Цель', draft.sections.purpose);
  section('Клинические данные', draft.sections.clinical);
  section('Обсуждение', draft.sections.discussion);
  section('Решение', draft.sections.decision);
  section('Особое мнение', draft.sections.dissent);
  return lines.join('\n');
}


/** Предел содержимого события Matrix — 64 КБ; оставляем запас. */
const MAX_TRANSCRIPT_BYTES = 40_000;

interface Session {
  roomId: string;
  callId: string;
  startedBy: string;
  startedAt: number;
}

/** Агент сам завершает сессию через 4 часа; сессия старше — потеряна (агент упал, не дозвонился). */
const STALE_SESSION_MS = 4.25 * 3600_000;

export class SecretaryService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      calls: CallTokenService;
      log: Logger;
      profile: AiProfile;
      secretaryUrl: string | null;
      secretaryToken: string;
      /** Адрес сервиса контекста, по которому до него достучится агент. */
      callbackBaseUrl: string;
      asrUrl: string | null;
      llm: LlmClient | null;
    },
  ) {}

  /** Сравнение токена агента за постоянное время. */
  checkToken(token: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(this.deps.secretaryToken);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  }

  get enabled(): boolean {
    return this.deps.profile !== 'off' && !!this.deps.secretaryUrl;
  }

  /** Примерный срок готовности итогов — интерфейс честно его показывает. */
  get etaMinutes(): number {
    return this.deps.profile === 'cpu' ? 30 : 5;
  }

  sessionFor(roomId: string): string | null {
    for (const [id, s] of this.sessions) {
      if (s.roomId !== roomId) continue;
      if (Date.now() - s.startedAt < STALE_SESSION_MS) return id;
      this.sessions.delete(id);
    }
    return null;
  }

  async start(userToken: string, roomId: string, callId = 'main'): Promise<{ sessionId: string }> {
    if (!this.enabled) throw new SecretaryError(501, 'ИИ-«Секретарь» выключен политикой организации');
    const userId = await this.ensureMember(userToken, roomId);
    if (this.sessionFor(roomId)) throw new SecretaryError(409, 'Стенограмма уже ведётся');
    // Итоги публикует сервис — значит, он должен быть в комнате: это чаты случаев, которые он создаёт.
    const ctx = await this.deps.matrix.getState(roomId, EventType.CaseContext).catch(() => null);
    if (!CaseContext.safeParse(ctx).success) throw new SecretaryError(409, 'Стенограмма доступна в чатах случаев');

    const sessionId = randomUUID();
    const token = await this.deps.calls.agentToken(roomId, callId, `secretary-${sessionId.slice(0, 8)}`, 'Секретарь (запись речи)');
    const res = await fetch(`${this.deps.secretaryUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.deps.secretaryToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        livekit_url: token.url,
        token: token.token,
        asr_url: this.deps.asrUrl,
        callback_url: `${this.deps.callbackBaseUrl}/internal/v1/secretary/sessions/${sessionId}/result`,
        callback_token: this.deps.secretaryToken,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => {
      throw new SecretaryError(503, `Секретарь недоступен: ${e.message}`);
    });
    if (!res.ok) throw new SecretaryError(503, `Секретарь ответил ${res.status}`);
    this.sessions.set(sessionId, { roomId, callId, startedBy: userId, startedAt: Date.now() });

    await this.setTranscription(roomId, callId, { started_by: userId, started_at: new Date().toISOString(), profile: this.deps.profile as 'gpu' | 'cpu' | 'external' }, userId);
    await this.deps.matrix.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.notice',
      body: `Включена стенограмма звонка (ИИ-«Секретарь»). Речь участников распознаётся в контуре организации; итоги — примерно через ${this.etaMinutes} мин после звонка.`,
    });
    return { sessionId };
  }

  async stop(userToken: string, roomId: string): Promise<void> {
    await this.ensureMember(userToken, roomId);
    const sessionId = this.sessionFor(roomId);
    if (!sessionId) throw new SecretaryError(409, 'Стенограмма не ведётся');
    // Агент завершит распознавание и пришлёт результат.
    const res = await fetch(`${this.deps.secretaryUrl}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.deps.secretaryToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    // Агент не знает сессию (перезапускался) — результата не будет: снимаем индикатор и честно говорим об этом.
    if (res?.status === 404) await this.abandon(sessionId, 'Стенограмма прервана: агент «Секретаря» перезапускался, запись не сохранена.');
  }

  private async abandon(sessionId: string, notice: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await this.setTranscription(session.roomId, session.callId, undefined, session.startedBy).catch(() => undefined);
    await this.deps.matrix.sendEvent(session.roomId, 'm.room.message', { msgtype: 'm.notice', body: notice }).catch(() => undefined);
  }

  /** Результат агента: стенограмма в чат, затем черновик протокола. Возвращает, когда стенограмма отправлена. */
  async onResult(sessionId: string, result: SecretaryResult): Promise<{ transcriptEventId: string; draft: Promise<void> }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SecretaryError(404, 'Неизвестная сессия');
    this.sessions.delete(sessionId);
    await this.setTranscription(session.roomId, session.callId, undefined, session.startedBy).catch((err) =>
      this.deps.log.warn({ err }, 'Не удалось снять индикатор стенограммы'),
    );

    if (result.segments.length === 0) {
      await this.deps.matrix.sendEvent(session.roomId, 'm.room.message', { msgtype: 'm.notice', body: 'Стенограмма звонка пуста: речь не распознана.' });
      return { transcriptEventId: '', draft: Promise.resolve() };
    }
    const transcriptEventId = await this.postTranscript(session, result);
    const draft = this.postDraft(session, result, transcriptEventId).catch((err) => this.deps.log.error({ err }, 'Черновик протокола не подготовлен'));
    return { transcriptEventId, draft };
  }

  private async ensureMember(userToken: string, roomId: string): Promise<string> {
    const userId = await this.deps.matrix.whoami(userToken);
    const members = await this.deps.matrix.joinedMembersAs(userToken, roomId).catch(() => {
      throw new ForbiddenError('Нет доступа к комнате');
    });
    if (!members.includes(userId)) throw new ForbiddenError('Только для участников чата');
    return userId;
  }

  private async setTranscription(roomId: string, callId: string, transcription: CallState['transcription'], fallbackStarter: string) {
    const current = CallState.safeParse(await this.deps.matrix.getState(roomId, EventType.Call, callId));
    const base: CallState = current.success
      ? current.data
      : { call_id: callId, kind: 'consilium', started_by: fallbackStarter, started_at: new Date().toISOString() };
    const { transcription: _old, ...rest } = base;
    await this.deps.matrix.sendState(roomId, EventType.Call, callId, { ...rest, ...(transcription ? { transcription } : {}) });
  }

  private async postTranscript(session: Session, result: SecretaryResult): Promise<string> {
    const segments: TranscriptSegment[] = [];
    let size = 0;
    for (const s of result.segments) {
      size += Buffer.byteLength(JSON.stringify(s));
      if (size > MAX_TRANSCRIPT_BYTES) break;
      segments.push(s);
    }
    const truncated = segments.length < result.segments.length;
    const body = [
      `Стенограмма звонка ${time(result.started_at)}–${time(result.ended_at)} (ИИ, без проверки)`,
      ...segments.map((s) => `${s.name}: ${s.text}`),
      ...(truncated ? ['… (стенограмма сокращена)'] : []),
    ].join('\n');
    const content: TranscriptMessage = {
      msgtype: MsgType.Transcript,
      body,
      [MsgType.Transcript]: {
        call_id: session.callId,
        started_at: result.started_at,
        ended_at: result.ended_at,
        segments,
        truncated,
        asr: { engine: result.asr.engine, profile: this.deps.profile as 'gpu' | 'cpu' | 'external' },
      },
    };
    return this.deps.matrix.sendEvent(session.roomId, 'm.room.message', content as unknown as Record<string, unknown>, `transcript.${result.session_id}`);
  }

  private async postDraft(session: Session, result: SecretaryResult, transcriptEventId: string) {
    const ctx = CaseContext.safeParse(await this.deps.matrix.getState(session.roomId, EventType.CaseContext).catch(() => null));
    const roles = ((await this.deps.matrix.getState<CaseRolesContent>(session.roomId, EventType.CaseRoles).catch(() => null))?.members ?? {}) as CaseRolesContent['members'];
    const speakers = new Map<string, string>();
    for (const p of result.participants) if (p.identity.startsWith('@')) speakers.set(p.identity, p.name);
    for (const s of result.segments) speakers.set(s.speaker, s.name);

    let sections: Sections | null = null;
    let model: string | undefined;
    if (this.deps.llm) {
      const transcript = result.segments
        .map((s) => `[${s.i}] ${s.name}${roles[s.speaker] ? ` (${roleName(roles[s.speaker]!.role)})` : ''}: ${s.text}`)
        .join('\n');
      try {
        // Только стенограмма: сведения о случае подставит система, модели их знать не нужно.
        const answer = await this.deps.llm.complete(SYSTEM_PROMPT, `Стенограмма:\n${transcript}\nОтвет:`);
        sections = parseLlmSections(answer, result.segments);
        if (sections) model = this.deps.llm.model;
        // Без содержимого ответа: в нём клиническое обсуждение.
        else this.deps.log.warn({ chars: answer.length, json: firstJsonObject(answer) !== undefined }, 'Ответ LLM не прошёл проверку — черновик по шаблону');
      } catch (err) {
        this.deps.log.warn({ err }, 'LLM недоступна — черновик по шаблону');
      }
    }
    const draft: ProtocolDraft[typeof MsgType.Report] = {
      kind: 'consilium_protocol',
      status: 'draft',
      generated_by: sections ? 'llm' : 'template',
      ...(model ? { model } : {}),
      ...(transcriptEventId ? { transcript_event_id: transcriptEventId } : {}),
      meeting: { date: date(result.started_at), start: time(result.started_at), end: time(result.ended_at), form: 'remote' },
      participants: [...speakers].map(([mxid, name]) => ({ mxid, name, ...(roles[mxid] ? { role: roleName(roles[mxid]!.role) } : {}) })),
      case: ctx.success ? { connector: ctx.data.connector, case_id: ctx.data.case_id, title: ctx.data.title, patient: ctx.data.patient.masked } : null,
      sections: sections ?? templateSections(result.segments),
    };
    const content = ProtocolDraft.parse({ msgtype: MsgType.Report, body: protocolBody(draft), [MsgType.Report]: draft });
    await this.deps.matrix.sendEvent(session.roomId, 'm.room.message', content as unknown as Record<string, unknown>, `draft.${result.session_id}`);
  }
}

export class SecretaryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
