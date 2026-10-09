import { describe, expect, it } from 'vitest';
import { EventType, MsgType, RoomType } from '@konsilium/protocol';
import {
  FOLDERS,
  firstUnreadIndex,
  typingText,
  archivedLabel,
  attachmentProblem,
  formatSize,
  highlightParts,
  quoteText,
  replyTarget,
  snippet,
  stripReplyFallback,
  avatarColor,
  caseCode,
  isArchivedState, countdown, criticalStatuses, criticalWaitingFor, foldersOf, formatDay, initials, offsetLabel, preview, reportDecisions, requestViews, type TimelineItem } from './model.ts';

const item = (eventId: string, type: string, content: Record<string, unknown>, sender = '@smirnova:konsilium.test'): TimelineItem => ({
  eventId,
  type,
  sender,
  ts: 0,
  content,
});

describe('foldersOf', () => {
  it('раскладывает комнаты по папкам', () => {
    expect(foldersOf({ roomType: RoomType.Case, isDirect: false })).toEqual(['all', 'cases']);
    expect(foldersOf({ isDirect: true })).toEqual(['all', 'direct']);
    expect(foldersOf({ roomType: RoomType.Channel, isDirect: false })).toEqual(['all', 'channels']);
  });

  it('«Архив» — папка по данным сервиса контекста: комнаты синхронизации в неё не попадают', () => {
    expect(FOLDERS.at(-1)).toEqual({ id: 'archive', label: 'Архив' });
    expect(foldersOf({ roomType: RoomType.Case, isDirect: false })).not.toContain('archive');
  });
});

describe('архив чата случая', () => {
  it('только чтение — пока статус archived; после возврата из архива — снова активен', () => {
    expect(isArchivedState({ status: 'archived', archived_at: '2026-10-08T10:00:00.000Z' })).toBe(true);
    expect(isArchivedState({ status: 'active', archived_at: '2026-10-08T10:00:00.000Z', restored_at: '2026-10-09T10:00:00.000Z' })).toBe(false);
    expect(isArchivedState(undefined)).toBe(false);
    expect(isArchivedState({ status: 'чужое' })).toBe(false);
    expect(archivedLabel('2026-10-08T10:00:00.000Z')).toMatch(/^в архиве с 8 окт/);
  });
});

describe('requestViews', () => {
  it('берёт последний статус заявки и шаги', () => {
    const items = [
      item('$r', 'm.room.message', { msgtype: MsgType.Request, body: 'Запрос ИГХ', [MsgType.Request]: { kind: 'ihc', items: ['ER'] } }),
      item('$s1', EventType.RequestStatus, { 'm.relates_to': { rel_type: 'm.reference', event_id: '$r' }, status: 'accepted', steps: ['accepted', 'staining', 'done'], external_id: 'ИГХ-1' }, '@ccs:x'),
      item('$s2', EventType.RequestStatus, { 'm.relates_to': { rel_type: 'm.reference', event_id: '$r' }, status: 'staining', steps: ['accepted', 'staining', 'done'], external_id: 'ИГХ-1' }, '@ccs:x'),
      item('$orphan', EventType.RequestStatus, { 'm.relates_to': { event_id: '$none' }, status: 'done' }, '@ccs:x'),
    ];
    const v = requestViews(items).get('$r')!;
    expect(v).toMatchObject({ kind: 'ihc', status: 'staining', externalId: 'ИГХ-1', steps: ['accepted', 'staining', 'done'] });
    expect(requestViews(items).size).toBe(1);
  });
});

describe('подписи', () => {
  it('код случая на аватаре', () => {
    expect(caseCode({ source: 'RIS', title: 'КТ-ангиопульмонография' })).toBe('КТ');
    expect(caseCode({ source: 'LIS', title: 'Биопсия', stage: 'ihc' })).toBe('ИГХ');
    expect(caseCode({ source: 'LIS', title: 'Биопсия' })).toBe('ГИСТ');
  });

  it('инициалы и стабильный цвет аватара', () => {
    expect(initials('Смирнова А. В.')).toBe('СА');
    expect(initials('@ershova')).toBe('E');
    expect(avatarColor('@a:x')).toBe(avatarColor('@a:x'));
  });

  it('превью последнего сообщения', () => {
    expect(preview(item('$1', 'm.room.message', { msgtype: 'm.text', body: 'Посмотрите блок 1А\nи 2Б' }), 'Смирнова А. В.', false)).toBe('Смирнова: Посмотрите блок 1А');
    expect(preview(item('$1', 'm.room.message', { msgtype: 'm.text', body: 'Да' }), 'x', true)).toBe('Вы: Да');
    expect(preview(item('$2', EventType.RequestStatus, { status: 'done', external_id: 'ИГХ-7' }), 'x', false)).toBe('Заявка ИГХ-7: готово');
  });

  it('день в ленте', () => {
    const now = new Date('2026-10-07T12:00:00+03:00').getTime();
    expect(formatDay(now - 3600_000, now)).toBe('Сегодня');
    expect(formatDay(now - 86_400_000, now)).toBe('Вчера');
  });
});

describe('ageLabel и membershipLine', () => {
  it('склоняет возраст', async () => {
    const { ageLabel } = await import('./model.ts');
    expect([1, 2, 5, 11, 12, 21, 54, 61, 67, 111, 112].map(ageLabel)).toEqual([
      '1 год', '2 года', '5 лет', '11 лет', '12 лет', '21 год', '54 года', '61 год', '67 лет', '111 лет', '112 лет',
    ]);
  });

  it('описывает изменения состава, скрывая сервисного пользователя', async () => {
    const { membershipKind, membershipText } = await import('./model.ts');
    const m = (sender: string, stateKey: string, membership: string) => ({ ...item('$m', 'm.room.member', { membership }, sender), stateKey });
    expect(membershipKind(m('@ccs:x', '@petrov:x', 'invite'), '@ccs:x')).toBe('invite');
    expect(membershipKind(m('@ccs:x', '@petrov:x', 'leave'), '@ccs:x')).toBe('revoked');
    expect(membershipKind(m('@petrov:x', '@petrov:x', 'leave'), '@ccs:x')).toBe('leave');
    expect(membershipKind(m('@ccs:x', '@ccs:x', 'join'), '@ccs:x')).toBeNull();
    expect(membershipText('invite', ['Смирнова А. В.', 'Ершова Т. Н.', 'Смирнова А. В.'])).toBe('Приглашение в чат: Смирнова А. В., Ершова Т. Н.');
  });
});

describe('reactionSummaries', () => {
  it('считает отметивших, порядок — как в наборе статусов, моя отметка снимаема', async () => {
    const { reactionSummaries } = await import('./model.ts');
    const r = (id: string, sender: string, target: string, key: string) => item(id, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } }, sender);
    const items = [
      r('$1', '@a:x', '$m', 'вопрос'),
      r('$2', '@b:x', '$m', 'принято'),
      r('$3', '@me:x', '$m', 'принято'),
      r('$4', '@me:x', '$m', 'принято'), // повтор той же отметки не удваивает счёт
      item('$5', 'm.reaction', {}, '@c:x'), // снятая (redacted) реакция без отношения
    ];
    expect(reactionSummaries(items, '@me:x').get('$m')).toEqual([
      { key: 'принято', label: 'Принято', count: 2, mine: '$4' },
      { key: 'вопрос', label: 'Вопрос', count: 1, mine: null },
    ]);
  });
});

describe('reportDecisions', () => {
  it('первое решение по черновику действует, ссылки без m.reference и чужие статусы игнорируются', () => {
    const ref = (id: string) => ({ 'm.relates_to': { rel_type: 'm.reference', event_id: id } });
    const items = [
      { ...item('$a1', EventType.ReportStatus, { ...ref('$draft'), status: 'accepted' }), ts: 10 },
      item('$a2', EventType.ReportStatus, { ...ref('$draft'), status: 'rejected' }, '@kolesnikov:konsilium.test'),
      item('$bad', EventType.ReportStatus, { 'm.relates_to': { event_id: '$other' }, status: 'accepted' }),
      item('$odd', EventType.ReportStatus, { ...ref('$other'), status: 'maybe' }),
    ];
    const d = reportDecisions(items);
    expect(d.get('$draft')).toEqual({ status: 'accepted', sender: '@smirnova:konsilium.test', ts: 10 });
    expect(d.has('$other')).toBe(false);
    expect(preview(items[0], 'Смирнова', true)).toBe('Черновик протокола принят');
  });

  it('смещение от начала звонка', () => {
    expect(offsetLabel(0)).toBe('0:00');
    expect(offsetLabel(245.7)).toBe('4:05');
  });
});

describe('критические находки', () => {
  const st = (status: string, recipients: string[], deadline = '2026-10-08T10:10:00Z') => ({
    status,
    raised_at: '2026-10-08T10:00:00Z',
    deadline_at: deadline,
    recipients,
    reported_by: '@orlov:x',
  });
  it('статус — только от сервиса; меня ждут неподтверждённые, где я адресат, по сроку', () => {
    const map = criticalStatuses(
      [
        { stateKey: '$a', sender: '@ccs:x', content: st('pending', ['@me:x'], '2026-10-08T10:20:00Z') },
        { stateKey: '$b', sender: '@ccs:x', content: st('pending', ['@me:x', '@other:x']) },
        { stateKey: '$c', sender: '@ccs:x', content: st('acknowledged', ['@me:x']) },
        { stateKey: '$d', sender: '@ccs:x', content: st('pending', ['@other:x']) },
        { stateKey: '$forged', sender: '@me:x', content: st('acknowledged', ['@me:x']) },
        { stateKey: '$bad', sender: '@ccs:x', content: { status: 'maybe' } },
      ],
      '@ccs:x',
    );
    expect([...map.keys()]).toEqual(['$a', '$b', '$c', '$d']);
    expect(criticalWaitingFor(map, '@me:x')).toEqual(['$b', '$a']);
  });

  it('обратный отсчёт до срока и после', () => {
    const now = Date.parse('2026-10-08T10:02:17Z');
    expect(countdown('2026-10-08T10:10:00Z', now)).toEqual({ text: 'осталось 7:43', overdue: false });
    expect(countdown('2026-10-08T10:00:00Z', now)).toEqual({ text: 'просрочено 2:17', overdue: true });
  });
});

describe('ответы с цитатой', () => {
  it('находит исходное сообщение и убирает старую цитату из текста', () => {
    expect(replyTarget({ body: 'Да', 'm.relates_to': { 'm.in_reply_to': { event_id: '$q1' } } })).toBe('$q1');
    expect(replyTarget({ body: 'Да' })).toBeNull();
    expect(stripReplyFallback('> <@smirnova:konsilium.test> Ставим ИГХ?\n> блок 1А\n\nДа, ставим')).toBe('Да, ставим');
    expect(stripReplyFallback('Без цитаты\n> не в начале')).toBe('Без цитаты\n> не в начале');
  });

  it('текст цитаты: первая строка, вложения и находки — подписью', () => {
    expect(quoteText(item('$1', 'm.room.message', { msgtype: 'm.text', body: 'Первая строка\nвторая' }))).toBe('Первая строка');
    expect(quoteText(item('$2', 'm.room.message', { msgtype: 'm.image', body: 'препарат.png' }))).toBe('Изображение: препарат.png');
    expect(quoteText(item('$3', 'm.room.message', { msgtype: 'm.file', body: 'заключение.pdf' }))).toBe('Файл: заключение.pdf');
    expect(quoteText(undefined)).toBe('Сообщение недоступно');
  });
});

describe('вложения', () => {
  it('размер файла по-русски', () => {
    expect(formatSize(12)).toBe('12 Б');
    expect(formatSize(340 * 1024)).toBe('340 КБ');
    expect(formatSize(1.25 * 1024 * 1024)).toBe('1,3 МБ');
    expect(formatSize(48 * 1024 * 1024)).toBe('48 МБ');
  });

  it('исполняемые, пустые и слишком большие файлы не отправляются', () => {
    const limit = 50 * 1024 * 1024;
    expect(attachmentProblem({ name: 'заключение.pdf', size: 1000 }, limit)).toBeNull();
    expect(attachmentProblem({ name: 'viewer.EXE', size: 1000 }, limit)).toMatch(/исполняемые/);
    expect(attachmentProblem({ name: 'macro.ps1', size: 1000 }, limit)).toMatch(/исполняемые/);
    expect(attachmentProblem({ name: 'пусто.txt', size: 0 }, limit)).toMatch(/пустой/);
    expect(attachmentProblem({ name: 'серия.dcm', size: limit + 1 }, limit)).toMatch(/больше 50 МБ/);
  });
});

describe('поиск по сообщениям', () => {
  it('подсвечивает слова по началу, без учёта регистра, в том числе кириллицу', () => {
    expect(highlightParts('Метастазы в лимфоузле; метастаз подтверждён', ['метастаз'])).toEqual([
      { text: 'Метастазы', hit: true },
      { text: ' в лимфоузле; ', hit: false },
      { text: 'метастаз', hit: true },
      { text: ' подтверждён', hit: false },
    ]);
    // Только с начала слова: «стаз» внутри «метастаз» не подсвечивается.
    expect(highlightParts('метастаз', ['стаз'])).toEqual([{ text: 'метастаз', hit: false }]);
    expect(highlightParts('HER2 (3+), her2-позитивный', ['her2'])).toEqual([
      { text: 'HER2', hit: true },
      { text: ' (3+), ', hit: false },
      { text: 'her2', hit: true },
      { text: '-позитивный', hit: false },
    ]);
  });

  it('фрагмент длинного сообщения — вокруг совпадения', () => {
    const long = `${'Описание макропрепарата. '.repeat(10)}Найден очаг 12 мм в верхней доле. ${'Прочее. '.repeat(10)}`;
    const s = snippet(long, ['очаг'], 60);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('очаг 12 мм');
    expect(s.length).toBeLessThanOrEqual(60);
    expect(snippet('Коротко', ['коротко'])).toBe('Коротко');
  });
});

describe('встраивание в ЛИС: «печатает…», непрочитанное, препарат', () => {
  it('«печатает…» по-русски', () => {
    expect(typingText([])).toBeNull();
    expect(typingText(['Колесников Д. А.'])).toBe('Колесников Д. А. печатает…');
    expect(typingText(['Смирнова А. В.', 'Ершова Т. Н.'])).toBe('Смирнова А. В. и Ершова Т. Н. печатают…');
    expect(typingText(['А', 'Б', 'В'])).toBe('3 участника печатают…');
  });

  it('разделитель — перед первым чужим сообщением после отметки о прочтении', () => {
    const me = '@smirnova:konsilium.test';
    const other = '@kolesnikov:konsilium.test';
    const items = [
      item('$1', 'm.room.message', { body: 'a' }, other),
      item('$2', 'm.room.message', { body: 'b' }, me),
      item('$3', 'm.room.member', { membership: 'join' }, other),
      item('$4', 'm.room.message', { body: 'c' }, other),
      item('$5', 'm.room.message', { body: 'd' }, other),
    ];
    expect(firstUnreadIndex(items, me, '$2', 0)).toBe(3);
    expect(firstUnreadIndex(items, me, '$5', 0)).toBeNull();
    // Отметки нет в загруженной ленте — по числу непрочитанных с конца.
    expect(firstUnreadIndex(items, me, '$старое', 2)).toBe(3);
    expect(firstUnreadIndex(items, me, null, 0)).toBeNull();
  });

  it('препарат в цитате и в списке чатов', () => {
    const slide = item('$s', 'm.room.message', { msgtype: MsgType.SlideRoi, body: 'Стекло 2, блок 1Б: H&E' });
    expect(quoteText(slide)).toBe('Препарат: Стекло 2, блок 1Б: H&E');
    expect(preview(slide, 'Смирнова А. В.', false)).toBe('Смирнова: Препарат: Стекло 2, блок 1Б: H&E');
  });
});
