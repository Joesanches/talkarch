import { useState, type FormEvent } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { MsgType, RequestMessage, requestFallbackBody, type Priority } from '@konsilium/protocol';

const KINDS = [
  { id: 'ihc', label: 'ИГХ' },
  { id: 'recut', label: 'Дорезка' },
  { id: 'review', label: 'Пересмотр' },
  { id: 'second_opinion', label: 'Второе мнение' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

const MARKERS = ['ER', 'PR', 'HER2/neu', 'Ki-67', 'CK7', 'CK20', 'p63', 'CD45'];
const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: 'routine', label: 'Обычно' },
  { id: 'urgent', label: 'Срочно' },
  { id: 'cito', label: 'CITO' },
];

/**
 * Заявка из чата случая: карточка `ru.vendor.request` уходит в ЛИС через сервис контекста,
 * статусы возвращаются в карточку. Текстовый `body` — для любых Matrix-клиентов.
 */
export function RequestForm({ client, roomId, onDone }: { client: MatrixClient; roomId: string; onDone: () => void }) {
  const [kind, setKind] = useState<Kind>('ihc');
  const [block, setBlock] = useState('');
  const [markers, setMarkers] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [priority, setPriority] = useState<Priority>('routine');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items = kind === 'ihc' ? [...markers, ...extra.split(',').map((s) => s.trim()).filter(Boolean)] : [];
  const valid = kind === 'ihc' ? items.length > 0 : kind === 'recut' ? block.trim().length > 0 : true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const request = { kind, block: block.trim() || undefined, items, priority, note: note.trim() || undefined };
    const content = RequestMessage.parse({ msgtype: MsgType.Request, body: requestFallbackBody({ ...request, items }), [MsgType.Request]: request });
    try {
      await client.sendMessage(roomId, content as never);
      onDone();
    } catch {
      setError('Не удалось отправить заявку');
    }
  }

  return (
    <form className="request-form" onSubmit={submit} aria-label="Новая заявка">
      <div className="segmented" role="radiogroup" aria-label="Вид заявки">
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      {kind !== 'second_opinion' && (
        <label className="field">
          Блок
          <input value={block} onChange={(e) => setBlock(e.target.value)} placeholder="например, 1А" maxLength={16} />
        </label>
      )}
      {kind === 'ihc' && (
        <fieldset className="markers">
          <legend>Маркеры</legend>
          {MARKERS.map((m) => (
            <label key={m} className={`marker${markers.includes(m) ? ' on' : ''}`}>
              <input type="checkbox" checked={markers.includes(m)} onChange={(e) => setMarkers(e.target.checked ? [...markers, m] : markers.filter((x) => x !== m))} />
              {m}
            </label>
          ))}
          <input className="markers-extra" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Другие через запятую" aria-label="Другие маркеры" />
        </fieldset>
      )}
      <div className="segmented small" role="radiogroup" aria-label="Срочность">
        {PRIORITIES.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={priority === p.id} className={priority === p.id ? `on ${p.id}` : ''} onClick={() => setPriority(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <label className="field">
        Комментарий
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="request-form-actions">
        <button type="button" className="ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="primary" disabled={!valid}>
          Отправить в ЛИС
        </button>
      </div>
    </form>
  );
}
