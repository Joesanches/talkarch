import { useEffect, useState } from 'react';
import type { ArchivedCase } from '@konsilium/protocol';
import { archivedLabel, caseCode } from '../model.ts';
import { fetchArchive, type Session } from '../matrix.ts';
import { Icon } from './Icon.tsx';

const kindColor: Record<string, string> = { LIS: 'var(--color-kind-pathology)', RIS: 'var(--color-kind-radiology)', TMK: 'var(--color-kind-consilium)' };

/**
 * Папка «Архив»: закрытые случаи, в чатах которых пользователь участвовал. Список даёт сервис контекста — из архивных
 * комнат участники выведены, в синхронизации их нет. Открыть — вернуться в чат только для чтения с полной историей.
 */
export function ArchiveList({ session, selected, onOpen }: { session: Session; selected: string | null; onOpen: (c: ArchivedCase) => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ArchivedCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    // Поиск — после паузы в наборе, чтобы не спрашивать сервис на каждую букву.
    const t = setTimeout(() => {
      fetchArchive(session, query, ctrl.signal)
        .then((r) => {
          setItems(r);
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setError('Архив недоступен: сервис контекста не отвечает');
        });
    }, query ? 250 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [session, query]);

  return (
    <aside className="list">
      <div className="list-search">
        <Icon name="search" size={18} />
        <input placeholder="Поиск в архиве: номер случая, название" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск в архиве" />
      </div>
      <ul className="rooms" role="listbox" aria-label="Архив">
        {error && <li className="rooms-hint">{error}</li>}
        {!error && items === null && <li className="rooms-hint">Загрузка…</li>}
        {!error && items?.length === 0 && (
          <li className="rooms-hint">{query.trim() ? 'Ничего не найдено' : 'Здесь появятся закрытые случаи, в чатах которых вы участвовали'}</li>
        )}
        {items?.map((c) => (
          <li
            key={c.room_id}
            role="option"
            aria-selected={selected === c.room_id}
            className={`room archived${selected === c.room_id ? ' selected' : ''}`}
            onClick={() => onOpen(c)}
          >
            <div className="avatar case normal" style={{ background: kindColor[c.source] }}>
              {caseCode({ source: c.source, title: c.title })}
            </div>
            <div className="room-body">
              <div className="room-top">
                <span className="room-name">
                  {c.case_id} · {c.title}
                </span>
              </div>
              <div className="room-bottom">
                <span className="room-preview">{archivedLabel(c.archived_at)}</span>
                <span className="chip archived">Только чтение</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
