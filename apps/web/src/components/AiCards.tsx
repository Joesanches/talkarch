import { useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  EventType,
  MsgType,
  type DraftStatement,
  type ProtocolDraft,
  type ReportDeliveryContent,
  type ReportStatusContent,
  type TranscriptMessage,
  type TranscriptSegment,
} from '@konsilium/protocol';
import { deliveryText, formatTime, offsetLabel, type ReportDecision } from '../model.ts';

const formLabel = { remote: 'дистанционно', in_person: 'очно', mixed: 'очно и дистанционно' } as const;

/** Стенограмма звонка от ИИ-«Секретаря»: начало сразу, остальное — по кнопке. */
export function TranscriptCard({ msg }: { msg: TranscriptMessage }) {
  const t = msg[MsgType.Transcript];
  const [open, setOpen] = useState(false);
  const shown = open ? t.segments : t.segments.slice(0, 3);
  return (
    <div className="ai-card" aria-label="Стенограмма звонка">
      <div className="ai-card-head">
        <b>Стенограмма звонка</b>
        <span className="chip ai">ИИ · без проверки</span>
      </div>
      <div className="meta">
        {formatTime(Date.parse(t.started_at))}–{formatTime(Date.parse(t.ended_at))} · фрагментов: {t.segments.length}
      </div>
      <ol className="segments">
        {shown.map((s) => (
          <li key={s.i}>
            <span className="seg-time">{offsetLabel(s.start_ms / 1000)}</span>
            <b>{s.name}</b> {s.text}
          </li>
        ))}
      </ol>
      {t.segments.length > 3 && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Свернуть' : `Показать полностью (${t.segments.length})`}
        </button>
      )}
      {t.truncated && <div className="meta">Стенограмма длинная — показано начало.</div>}
    </div>
  );
}

const SECTIONS: ReadonlyArray<{ key: keyof ProtocolDraft[typeof MsgType.Report]['sections']; title: string; empty: string }> = [
  { key: 'purpose', title: 'Цель консилиума', empty: 'не прозвучала — заполните' },
  { key: 'clinical', title: 'Клинические данные', empty: 'не прозвучали' },
  { key: 'discussion', title: 'Позиции участников', empty: '—' },
  { key: 'decision', title: 'Решение', empty: 'заполняет врач' },
  { key: 'dissent', title: 'Особое мнение', empty: 'нет' },
];

/** Утверждение черновика: номера фрагментов раскрывают цитату из стенограммы — проверка без поиска по тексту. */
function Statement({ s, segments }: { s: DraftStatement; segments: Map<number, TranscriptSegment> }) {
  const [quote, setQuote] = useState(false);
  const quoted = s.refs.map((r) => segments.get(r)).filter((x): x is TranscriptSegment => !!x);
  return (
    <li>
      {s.speaker && <b>{s.speaker}: </b>}
      {s.text}{' '}
      {s.refs.length > 0 && (
        <button className="ref" onClick={() => setQuote(!quote)} aria-expanded={quote} title="Показать фрагменты стенограммы" disabled={!quoted.length}>
          [{s.refs.join(', ')}]
        </button>
      )}
      {quote && (
        <blockquote>
          {quoted.map((q) => (
            <div key={q.i}>
              <span className="seg-time">{offsetLabel(q.start_ms / 1000)}</span>
              <b>{q.name}</b> {q.text}
            </div>
          ))}
        </blockquote>
      )}
    </li>
  );
}

/**
 * Черновик протокола консилиума по случаю повестки — в комнате консилиума: краткая карточка, проверка и принятие —
 * на экране протокола рядом со стенограммой.
 */
function ConsiliumDraftCard(props: { msg: ProtocolDraft; decision: ReportDecision | undefined; delivery: ReportDeliveryContent | undefined; lead: boolean; onReview: () => void; name: (userId: string) => string }) {
  const d = props.msg[MsgType.Report];
  const { decision } = props;
  return (
    <div className="ai-card" aria-label="Черновик протокола">
      <div className="ai-card-head">
        <b>
          Черновик протокола · случай {d.agenda!.index + 1} из {d.agenda!.total}
        </b>
        <span className="chip ai">{d.generated_by === 'llm' ? 'Черновик ИИ' : 'Черновик · шаблон'}</span>
      </div>
      <div className="meta">
        {d.case && (
          <>
            <span className="mono">{d.case.case_id}</span> · {d.case.title} · {d.case.patient} ·{' '}
          </>
        )}
        {d.meeting.start}–{d.meeting.end}
      </div>
      <div className="draft-actions">
        {decision && (
          <span className={`chip ${decision.status === 'accepted' ? 'done' : 'cito'}`} role="status">
            {decision.status === 'accepted' ? 'Принят' : 'Отклонён'} · {props.name(decision.sender)}, {formatTime(decision.ts)}
          </span>
        )}
        <button className={props.lead && !decision ? 'primary' : 'ghost'} onClick={props.onReview}>
          {props.lead && !decision ? 'Проверить и принять' : 'Открыть протокол'}
        </button>
      </div>
      {props.delivery && <div className="meta">{deliveryText(props.delivery)}</div>}
    </div>
  );
}

/**
 * Черновик протокола консилиума. Состав, случай и время подставлены системой, разделы — ИИ со ссылками на стенограмму.
 * Врач принимает черновик в протокол или отклоняет; решение видно всем и попадает в журнал комнаты.
 * Черновик по случаю консилиума (`agenda`) — краткой карточкой с переходом к проверке; принятая копия в чате случая
 * (`status: accepted`) — протоколом без кнопок.
 */
export function ProtocolDraftCard(props: {
  client: MatrixClient;
  roomId: string;
  eventId: string;
  msg: ProtocolDraft;
  segments: Map<number, TranscriptSegment>;
  decision: ReportDecision | undefined;
  canDecide: boolean;
  name: (userId: string) => string;
  /** Консилиум: открыть экран проверки протокола. */
  onReview?: () => void;
  delivery?: ReportDeliveryContent;
  lead?: boolean;
}) {
  const { msg, decision } = props;
  const d = msg[MsgType.Report];
  if (d.agenda && d.status === 'draft' && props.onReview) {
    return <ConsiliumDraftCard msg={msg} decision={decision} delivery={props.delivery} lead={!!props.lead && props.canDecide} onReview={props.onReview} name={props.name} />;
  }
  const accepted = d.status === 'accepted' ? d.accepted : undefined;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function decide(status: ReportStatusContent['status']) {
    setBusy(true);
    const content: ReportStatusContent = { 'm.relates_to': { rel_type: 'm.reference', event_id: props.eventId }, status };
    await props.client.sendEvent(props.roomId, EventType.ReportStatus as never, content as never).catch(() => undefined);
    setBusy(false);
  }

  async function copy() {
    await navigator.clipboard?.writeText(msg.body).then(() => setCopied(true), () => undefined);
  }

  return (
    <div className="ai-card" aria-label={accepted ? 'Протокол консилиума' : 'Черновик протокола'}>
      <div className="ai-card-head">
        <b>{accepted ? 'Протокол консилиума · принят' : 'Черновик протокола консилиума'}</b>
        <span className="chip ai">{accepted ? 'подписание — в МИС' : d.generated_by === 'llm' ? 'Черновик ИИ' : 'Черновик · шаблон'}</span>
      </div>
      <dl className="draft-meta">
        <dt>Дата</dt>
        <dd>
          {d.meeting.date}, {d.meeting.start}–{d.meeting.end}, {formLabel[d.meeting.form]}
        </dd>
        {d.agenda && (
          <>
            <dt>Консилиум</dt>
            <dd>
              {d.agenda.consilium}, случай {d.agenda.index + 1} из {d.agenda.total}
            </dd>
          </>
        )}
        {d.case && (
          <>
            <dt>Случай</dt>
            <dd>
              <span className="mono">{d.case.case_id}</span> · {d.case.title} · {d.case.patient}
            </dd>
          </>
        )}
        <dt>Состав</dt>
        <dd>{d.participants.map((p) => `${p.name}${p.role ? ` (${p.role}${p.remote ? ', дистанционно' : ''})` : p.remote ? ' (дистанционно)' : ''}`).join(', ') || '—'}</dd>
      </dl>
      {SECTIONS.map(({ key, title, empty }) => (
        <section key={key} className="draft-section">
          <h4>{title}</h4>
          {d.sections[key].length ? (
            <ul>
              {d.sections[key].map((s, i) => (
                <Statement key={i} s={s} segments={props.segments} />
              ))}
            </ul>
          ) : (
            <div className="meta">{empty}</div>
          )}
        </section>
      ))}
      <div className="draft-actions">
        {accepted ? (
          <span className="chip done" role="status">
            Принят: {accepted.name}, {formatTime(Date.parse(accepted.at))} · подписание — в МИС
          </span>
        ) : decision ? (
          <span className={`chip ${decision.status === 'accepted' ? 'done' : 'cito'}`} role="status">
            {decision.status === 'accepted' ? 'Принят в протокол' : 'Отклонён'} · {props.name(decision.sender)}, {formatTime(decision.ts)}
          </span>
        ) : (
          props.canDecide && (
            <>
              <button className="primary" disabled={busy} onClick={() => void decide('accepted')}>
                Принять в протокол
              </button>
              <button className="ghost" disabled={busy} onClick={() => void decide('rejected')}>
                Отклонить
              </button>
            </>
          )
        )}
        <button className="link" onClick={() => void copy()}>
          {copied ? 'Скопировано' : 'Копировать текст'}
        </button>
      </div>
      {d.generated_by === 'llm' && !accepted && <div className="meta">Сформировано ИИ{d.model ? ` (${d.model})` : ''}. Проверьте каждое утверждение по стенограмме.</div>}
    </div>
  );
}
