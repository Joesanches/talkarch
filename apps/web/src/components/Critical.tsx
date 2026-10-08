import { useEffect, useState, type FormEvent } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { CriticalMessage, EventType, MsgType, type AckContent, type CriticalStatusContent } from '@konsilium/protocol';
import { countdown, delayLabel, formatTime, roleLabel } from '../model.ts';

/** Перерисовка раз в секунду — для обратного отсчёта. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

async function acknowledge(client: MatrixClient, roomId: string, eventId: string) {
  const content: AckContent = { 'm.relates_to': { rel_type: 'm.reference', event_id: eventId } };
  await client.sendEvent(roomId, EventType.Ack as never, content as never);
}

function AckButton({ client, roomId, eventId, large }: { client: MatrixClient; roomId: string; eventId: string; large?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`primary critical-ack${large ? ' large' : ''}`}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void acknowledge(client, roomId, eventId)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Отправка…' : 'Подтверждаю получение'}
    </button>
  );
}

/**
 * Карточка критической находки. Статус — только из state-события сервиса: адресаты, срок, эскалации, подтверждение.
 * Адресат видит большую кнопку «Подтверждаю получение», отправитель — обратный отсчёт до эскалации.
 */
export function CriticalCard(props: {
  client: MatrixClient;
  roomId: string;
  eventId: string;
  msg: CriticalMessage;
  sender: string;
  status: CriticalStatusContent | undefined;
  me: string;
  name: (userId: string) => string;
}) {
  const { msg, status } = props;
  const c = msg[MsgType.Critical];
  const pending = status?.status === 'pending';
  const now = useNow(pending);
  const reporter = c.reported_by ?? props.sender;
  const recipients = status?.recipients.length ? status.recipients.map(props.name).join(', ') : c.recipient.role ? roleLabel(c.recipient.role) : '—';
  const left = pending ? countdown(status.deadline_at, now) : null;
  return (
    <div className={`critical${status?.status === 'acknowledged' ? ' done' : ''}`} aria-label="Критическая находка">
      <div className="critical-head">
        <span className="critical-mark" aria-hidden>
          !
        </span>
        Критическая находка
      </div>
      <div className="critical-finding">{c.finding}</div>
      <div className="meta">
        Сообщил: {props.name(reporter)} · Кому: {recipients}
      </div>
      <div className="critical-status" role="status">
        {!status && <span className="meta">Регистрируется…</span>}
        {pending && (
          <>
            <span className="chip cito">Ждёт подтверждения</span>
            <span className={`critical-timer${left!.overdue ? ' overdue' : ''}`}>{left!.text}</span>
            {status.next_escalation_at && <span className="meta">эскалация в {formatTime(Date.parse(status.next_escalation_at))}</span>}
          </>
        )}
        {status?.status === 'acknowledged' && status.acknowledged && (
          <span className="chip done">
            Подтверждено: {props.name(status.acknowledged.by)}, через {delayLabel(status.acknowledged.seconds)}
            {Date.parse(status.acknowledged.at) > Date.parse(status.deadline_at) ? ' (позже срока)' : ''}
          </span>
        )}
        {status?.status === 'rejected' && <span className="chip closed">Не отслеживается: {status.note ?? 'отклонена сервисом'}</span>}
      </div>
      {status && status.escalations.length > 0 && (
        <ol className="critical-escalations" aria-label="Эскалации">
          {status.escalations.map((e, i) => (
            <li key={i}>
              {formatTime(Date.parse(e.at))} —{' '}
              {e.action === 'call'
                ? `звонок на «${e.target}»${e.delivered === false ? ' (вручную)' : ''}`
                : e.users.length
                  ? `подключён ${e.users.map(props.name).join(', ')}`
                  : `эскалация на «${roleLabel(e.target)}»`}
            </li>
          ))}
        </ol>
      )}
      {pending && status.recipients.includes(props.me) && <AckButton client={props.client} roomId={props.roomId} eventId={props.eventId} large />}
    </div>
  );
}

/** Закреплённая полоса над лентой: находка ждёт моего подтверждения. Видна, пока я не подтвердил. */
export function CriticalBar(props: {
  client: MatrixClient;
  roomId: string;
  waiting: Array<{ eventId: string; finding: string; status: CriticalStatusContent }>;
}) {
  const first = props.waiting[0];
  const now = useNow(!!first);
  if (!first) return null;
  const left = countdown(first.status.deadline_at, now);
  return (
    <div className="critical-bar" role="alert" aria-label="Критическая находка ждёт подтверждения">
      <span className="critical-mark" aria-hidden>
        !
      </span>
      <div className="critical-bar-text">
        <b>Критическая находка — подтвердите получение</b>
        <span>{first.finding}</span>
      </div>
      <span className={`critical-timer${left.overdue ? ' overdue' : ''}`}>{left.text}</span>
      {props.waiting.length > 1 && <span className="chip cito">ещё {props.waiting.length - 1}</span>}
      <AckButton client={props.client} roomId={props.roomId} eventId={first.eventId} />
    </div>
  );
}

const DEADLINES = [5, 10, 15, 30] as const;

/**
 * Отправка критической находки адресату по роли. Срок и план эскалации ведёт сервис контекста;
 * упоминание адресатов включает у них уведомление.
 */
export function CriticalForm(props: {
  client: MatrixClient;
  roomId: string;
  /** Роли в случае → участники (кроме меня). */
  roles: Map<string, string[]>;
  onDone: () => void;
}) {
  const options = [...props.roles.keys()];
  const [finding, setFinding] = useState('');
  const [role, setRole] = useState(options.includes('attending') ? 'attending' : options.includes('on_duty') ? 'on_duty' : (options[0] ?? ''));
  const [minutes, setMinutes] = useState<(typeof DEADLINES)[number]>(10);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = finding.trim();
    const parsed = CriticalMessage.safeParse({
      msgtype: MsgType.Critical,
      body: `Критическая находка: ${text}`,
      [MsgType.Critical]: { finding: text, recipient: { role, users: [] }, ack_required: true, ack_deadline: `PT${minutes}M` },
    });
    if (!parsed.success) return setError('Проверьте текст и адресата');
    try {
      await props.client.sendMessage(props.roomId, { ...parsed.data, 'm.mentions': { user_ids: props.roles.get(role) ?? [] } } as never);
      props.onDone();
    } catch {
      setError('Не удалось отправить находку');
    }
  }

  return (
    <form className="request-form critical-form" onSubmit={submit} aria-label="Критическая находка">
      <label className="field">
        Находка
        <textarea value={finding} onChange={(e) => setFinding(e.target.value)} maxLength={1000} rows={2} placeholder="Например: двусторонняя ТЭЛА, долевые ветви" required />
      </label>
      <div className="segmented" role="radiogroup" aria-label="Кому">
        {options.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>
            {roleLabel(r)}
          </button>
        ))}
      </div>
      <div className="segmented small" role="radiogroup" aria-label="Срок подтверждения">
        {DEADLINES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={minutes === m} className={minutes === m ? 'on' : ''} onClick={() => setMinutes(m)}>
            {m} мин
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="request-form-actions">
        <button type="button" className="ghost" onClick={props.onDone}>
          Отмена
        </button>
        <button type="submit" className="primary danger" disabled={!finding.trim() || !role}>
          Отправить находку
        </button>
      </div>
    </form>
  );
}
