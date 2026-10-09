import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  EventType,
  MsgType,
  type ConsiliumContent,
  type DraftStatement,
  type ProtocolDraft,
  type ReportDeliveryContent,
  type ReportStatusContent,
  type TranscriptMessage,
  type TranscriptSegment,
} from '@konsilium/protocol';
import { ageLabel, caseCode, caseSegments, consiliumMemberLabel, deliveryText, formatTime, offsetLabel, plural, type ReportDecision } from '../model.ts';
import { Icon } from './Icon.tsx';

const CASES = ['случай', 'случая', 'случаев'] as const;
const formLabel = { remote: 'дистанционно', in_person: 'очно', mixed: 'очно и дистанционно' } as const;

const scheduled = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

/**
 * Повестка консилиума над лентой: текущий случай и докладчик. Председатель и секретарь переключают случай —
 * по этим отметкам «Секретарь» делит стенограмму.
 */
export function ConsiliumBar(props: { consilium: ConsiliumContent; current: number; lead: boolean; onSelect: (index: number) => void; name: (userId: string) => string }) {
  const { consilium: c, current, lead } = props;
  const members = Object.entries(c.members);
  return (
    <section className="consilium-bar" aria-label="Повестка консилиума">
      <div className="consilium-meta">
        {scheduled(c.scheduled_at)} · {formLabel[c.form]} · {plural(c.agenda.length, CASES)}
        {lead && <span className="chip">вы ведёте</span>}
      </div>
      <ol className="agenda">
        {c.agenda.map((a, i) => (
          <li key={`${a.connector}:${a.case_id}`}>
            <button
              className={`agenda-item${i === current ? ' current' : ''}`}
              aria-current={i === current ? 'step' : undefined}
              disabled={!lead || i === current}
              onClick={() => props.onSelect(i)}
              title={lead && i !== current ? 'Сделать текущим случаем' : undefined}
            >
              <span className="agenda-num">{i + 1}</span>
              <span className="tag">{caseCode(a)}</span>
              <span className="mono">{a.case_id}</span>
              <span className="agenda-patient">
                {a.patient.masked}
                {a.patient.age !== undefined ? `, ${a.patient.age}` : ''}
              </span>
              {a.presenter && <span className="muted">докл. {props.name(a.presenter)}</span>}
            </button>
          </li>
        ))}
      </ol>
      <div className="consilium-actions">
        {lead && current < c.agenda.length - 1 && (
          <button className="ghost" onClick={() => props.onSelect(current + 1)}>
            <Icon name="next" size={16} /> Следующий случай
          </button>
        )}
        <details className="roster">
          <summary>Состав · {members.length}</summary>
          <ul>
            {members.map(([id, m]) => (
              <li key={id}>
                <b>{props.name(id)}</b> — {consiliumMemberLabel(m)}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}

type SectionKey = keyof ProtocolDraft[typeof MsgType.Report]['sections'];
const SECTIONS: ReadonlyArray<{ key: SectionKey; title: string; must?: boolean; empty: string }> = [
  { key: 'purpose', title: 'Цель', empty: 'В стенограмме не найдено — заполните в МИС.' },
  { key: 'clinical', title: 'Клинические данные', empty: 'В стенограмме не найдено.' },
  { key: 'discussion', title: 'Обсуждение', empty: 'Позиции участников не найдены.' },
  { key: 'decision', title: 'Решение', must: true, empty: 'Решение не найдено — заполните в МИС.' },
  { key: 'dissent', title: 'Особое мнение', empty: 'Не высказано — в стенограмме не найдено.' },
];

export interface ConsiliumDraftView {
  eventId: string;
  msg: ProtocolDraft;
}

/** «00:12:04» от начала стенограммы. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
};

const loadChecks = (eventId: string): Partial<Record<SectionKey, boolean>> => {
  try {
    return JSON.parse(localStorage.getItem(`konsilium.review.${eventId}`) ?? '{}') as Partial<Record<SectionKey, boolean>>;
  } catch {
    return {};
  }
};
const saveChecks = (eventId: string, checks: Partial<Record<SectionKey, boolean>>) => {
  try {
    localStorage.setItem(`konsilium.review.${eventId}`, JSON.stringify(checks));
  } catch {
    /* хранилище недоступно — отметки живут до закрытия */
  }
};

/**
 * Проверка черновиков протокола консилиума (макет ConsiliumProtocol): слева — повестка и состав, в центре — протокол
 * случая с отметками «Проверено», справа — стенограмма этого случая. Ссылка-время в утверждении показывает фрагмент.
 * Принять можно, только отметив все разделы, подготовленные ИИ; принятый протокол сервис отправляет в МИС.
 */
export function ConsiliumReview(props: {
  client: MatrixClient;
  roomId: string;
  consilium: ConsiliumContent;
  drafts: ConsiliumDraftView[];
  selected: string;
  onSelect: (eventId: string) => void;
  transcript: TranscriptMessage | null;
  decisions: Map<string, ReportDecision>;
  deliveries: Map<string, ReportDeliveryContent>;
  lead: boolean;
  name: (userId: string) => string;
  onClose: () => void;
}) {
  const { consilium: c } = props;
  const view = props.drafts.find((d) => d.eventId === props.selected) ?? props.drafts[0]!;
  const d = view.msg[MsgType.Report];
  const index = d.agenda?.index ?? 0;
  const item = c.agenda[index];
  const t = props.transcript?.[MsgType.Transcript] ?? null;
  const segments = useMemo(() => (t ? caseSegments(t.segments, index) : []), [t, index]);
  const byI = useMemo(() => new Map((t?.segments ?? []).map((s) => [s.i, s])), [t]);
  const decision = props.decisions.get(view.eventId);
  const delivery = props.deliveries.get(view.eventId);
  const canDecide = props.lead && !decision;

  const [checks, setChecks] = useState<Partial<Record<SectionKey, boolean>>>(() => loadChecks(view.eventId));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    setChecks(loadChecks(view.eventId));
    setTried(false);
    setPicked(null);
    setQuery('');
  }, [view.eventId]);
  const checked = SECTIONS.filter((s) => checks[s.key]).length;
  const ready = checked === SECTIONS.length;

  const lines = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (picked !== null) lines.current?.querySelector(`[data-i="${picked}"]`)?.scrollIntoView({ block: 'center' });
  }, [picked]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(key: SectionKey) {
    const next = { ...checks, [key]: !checks[key] };
    setChecks(next);
    saveChecks(view.eventId, next);
    setTried(false);
  }

  async function decide(status: ReportStatusContent['status']) {
    if (status === 'accepted' && !ready) return setTried(true);
    setBusy(true);
    const content: ReportStatusContent = { 'm.relates_to': { rel_type: 'm.reference', event_id: view.eventId }, status };
    await props.client.sendEvent(props.roomId, EventType.ReportStatus as never, content as never).catch(() => undefined);
    setBusy(false);
  }

  const statusOf = (eventId: string) => {
    const dec = props.decisions.get(eventId);
    if (dec) return dec.status === 'accepted' ? 'принят' : 'отклонён';
    return eventId === view.eventId ? 'проверка' : 'черновик готов';
  };
  const roleOf = (mxid: string) => (c.members[mxid] || item?.presenter === mxid ? consiliumMemberLabel(c.members[mxid], item?.presenter === mxid) : '');
  const statement = (s: DraftStatement, i: number) => (
    <li key={i}>
      {s.speaker && <b>{s.speaker}: </b>}
      {s.text}
      {s.refs.map((r) => {
        const seg = byI.get(r);
        return seg ? (
          <button key={r} className={`cite${picked === r ? ' on' : ''}`} onClick={() => setPicked(r)} aria-label={`Фрагмент ${offsetLabel(seg.start_ms / 1000)}`}>
            {offsetLabel(seg.start_ms / 1000)}
          </button>
        ) : null;
      })}
    </li>
  );
  const filtered = query.trim() ? segments.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(query.trim().toLowerCase())) : segments;
  const range = segments.length ? `${clock(segments[0]!.start_ms)}–${clock(segments.at(-1)!.end_ms)}` : '';
  const pickedSeg = picked !== null ? byI.get(picked) : undefined;

  return (
    <div className="review-backdrop">
      <div className="review" role="dialog" aria-modal="true" aria-label="Протокол консилиума">
        <header className="review-head">
          <div>
            <h2>{c.title} · черновик протокола</h2>
            <div className="meta">
              {d.meeting.date}, {d.meeting.start}–{d.meeting.end} · {plural(c.agenda.length, CASES)}
              {t && ` · стенограмма: ${t.asr.engine}${t.asr.profile === 'cpu' ? ', сервер клиники (только CPU)' : ''}`}
            </div>
          </div>
          <span className="chip ai">{d.generated_by === 'llm' ? 'Черновик ИИ — требует проверки' : 'Черновик по шаблону — требует проверки'}</span>
          <button className="icon-btn" onClick={props.onClose} aria-label="Закрыть" title="Закрыть">
            <Icon name="close" />
          </button>
        </header>

        <div className="review-grid">
          <aside className="review-side">
            <h3>Повестка · {plural(c.agenda.length, CASES)}</h3>
            <ul className="review-agenda">
              {c.agenda.map((a, i) => {
                const draft = props.drafts.find((x) => x.msg[MsgType.Report].agenda?.index === i);
                return (
                  <li key={`${a.connector}:${a.case_id}`}>
                    <button className={`review-case${draft?.eventId === view.eventId ? ' on' : ''}`} disabled={!draft} onClick={() => draft && props.onSelect(draft.eventId)}>
                      <span className="tag">{caseCode(a)}</span>
                      <span className="mono">{a.case_id}</span>
                      <span className="muted">
                        {a.patient.masked}
                        {a.patient.age !== undefined ? `, ${a.patient.age}` : ''} · {draft ? statusOf(draft.eventId) : 'нет черновика'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <h3>Состав · из данных встречи</h3>
            <ul className="review-roster">
              {d.participants.map((p) => (
                <li key={p.mxid}>
                  <b>{p.name}</b> — {p.role ?? 'участник'}
                  {p.remote ? ' · дистанционно' : ''}
                </li>
              ))}
            </ul>
          </aside>

          <section className="review-main" aria-label={`Протокол · случай ${index + 1}`}>
            <div className="review-title">
              <h3>
                Протокол консилиума · случай {index + 1} из {c.agenda.length}
              </h3>
              <div className="muted">Нажмите на отметку времени, чтобы увидеть фрагмент стенограммы</div>
              <div className="review-progress">
                <span>
                  Проверено {checked} из {SECTIONS.length} разделов
                </span>
                <span className="bar">
                  <span style={{ width: `${Math.round((checked / SECTIONS.length) * 100)}%` }} />
                </span>
              </div>
            </div>
            <dl className="review-facts">
              <dt>
                Дата и форма <span className="chip">данные встречи</span>
              </dt>
              <dd>
                {d.meeting.date}, {d.meeting.start} · {formLabel[d.meeting.form]}
                {d.participants.some((p) => p.remote) ? `, дистанционно: ${d.participants.filter((p) => p.remote).map((p) => p.name).join(', ')}` : ''}
              </dd>
              <dt>
                Пациент <span className="chip">из системы, не ИИ</span>
              </dt>
              <dd>
                {d.case?.patient}
                {item?.patient.age !== undefined ? `, ${ageLabel(item.patient.age)}` : ''} · случай <span className="mono">{d.case?.case_id}</span> · {d.case?.title} · состав консилиума — {plural(d.participants.length, ['человек', 'человека', 'человек'])}
              </dd>
            </dl>
            {SECTIONS.map((s) => (
              <section key={s.key} className={`review-section${checks[s.key] ? ' checked' : ''}`}>
                <header>
                  <h4>{s.title}</h4>
                  <span className={`chip ai${s.must ? ' must' : ''}`}>{s.must ? 'ИИ · проверить обязательно' : 'ИИ · проверить'}</span>
                  <label className="check">
                    <input type="checkbox" checked={!!checks[s.key]} onChange={() => toggle(s.key)} disabled={!canDecide} aria-label={`Проверено: ${s.title}`} />
                    Проверено
                  </label>
                </header>
                {d.sections[s.key].length ? <ul>{d.sections[s.key].map(statement)}</ul> : <p className="muted">{s.empty}</p>}
              </section>
            ))}
            <footer className="review-foot">
              <div className="muted">Пациент и состав взяты из систем. Подписание — в МИС (УКЭП участников).</div>
              {decision ? (
                <div className="review-status" role="status">
                  {decision.status === 'accepted' ? (delivery ? deliveryText(delivery) : 'Принят · передаётся в МИС…') : 'Черновик отклонён'} · {props.name(decision.sender)}, {formatTime(decision.ts)}
                </div>
              ) : canDecide ? (
                <div className="review-actions">
                  <button className="ghost" disabled={busy} onClick={() => void decide('rejected')}>
                    Отклонить черновик
                  </button>
                  {/* Неготовая кнопка нажимается: по нажатию — подсказка, какие разделы ещё не проверены. */}
                  <button className={ready ? 'primary' : 'primary not-ready'} disabled={busy} onClick={() => void decide('accepted')}>
                    Принять в протокол МИС
                  </button>
                </div>
              ) : (
                <div className="muted">Принимают протокол председатель и секретарь консилиума.</div>
              )}
              {tried && !ready && (
                <div className="hint" role="alert">
                  Отметьте «Проверено» во всех разделах, подготовленных ИИ.
                </div>
              )}
            </footer>
          </section>

          <aside className="review-transcript" aria-label={`Стенограмма · случай ${index + 1}`}>
            <h3>Стенограмма · случай {index + 1}</h3>
            <div className="muted">
              {range}
              {pickedSeg && ` · выбран фрагмент ${clock(pickedSeg.start_ms)}`}
            </div>
            <input className="search" type="search" placeholder="Поиск по стенограмме" aria-label="Поиск по стенограмме" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ol className="transcript-lines" ref={lines}>
              {filtered.map((s: TranscriptSegment) => (
                <li key={s.i} data-i={s.i} className={picked === s.i ? 'on' : ''} onClick={() => setPicked(s.i)}>
                  <span className="seg-time">{offsetLabel(s.start_ms / 1000)}</span>
                  <b>{s.name}</b>
                  {roleOf(s.speaker) && <span className="muted"> · {roleOf(s.speaker)}</span>}
                  <div>{s.text}</div>
                </li>
              ))}
              {!filtered.length && <li className="muted">{segments.length ? 'Ничего не найдено' : 'Стенограммы этого случая нет'}</li>}
            </ol>
            {t && <div className="muted small">Распознавание: {t.asr.engine} · агент «Секретарь» был виден всем участникам</div>}
          </aside>
        </div>
      </div>
    </div>
  );
}
