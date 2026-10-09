// Первичные данные комнаты в текущем соединении (docs/11-load-test.md, 7.4): 1) приглашение → вход, 2) новая подписка
// на комнату, 3) то же в обычной синхронизации. Сравнение — с новым соединением и /messages.
// Аргументы: адрес сервера, токен регистрации (Tuwunel: registration_token).
const [hs, token] = [process.argv[2], process.argv[3]];
const call = async (method, path, body, auth) => {
  const r = await fetch(hs + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
const user = async (name) => {
  const s = await call('POST', '/_matrix/client/v3/register', { username: name, password: 'dev-only-probe-1' });
  return call('POST', '/_matrix/client/v3/register', { username: name, password: 'dev-only-probe-1', auth: { type: 'm.login.registration_token', token, session: s.session } });
};
const t = Date.now();
const a = await user(`probe-ha-${t}`), b = await user(`probe-hb-${t}`);
const room = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat', invite: [b.user_id] }, a.access_token)).room_id;
const hv = await call('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.history_visibility/`, undefined, a.access_token);
await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/m1`, { msgtype: 'm.text', body: 'сообщение до входа' }, a.access_token);
const sss = (body, pos) => call('POST', `/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0${pos ? `&pos=${pos}` : ''}`, body, b.access_token);
const list = { lists: { all: { ranges: [[0, 19]], timeline_limit: 3, required_state: [['m.room.name', '']] } } };
const first = await sss(list);
console.log('history_visibility:', hv.history_visibility, '| invite in list:', JSON.stringify(first.rooms?.[room]?.membership ?? first.rooms?.[room] ?? null).slice(0, 120));
await call('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, b.access_token);
const inc = await sss({ ...list, room_subscriptions: { [room]: { timeline_limit: 50, required_state: [['*', '*']] } } }, first.pos);
const tl = (r) => (r?.timeline ?? []).map((e) => `${e.type}${e.content?.body ? `:${e.content.body}` : e.content?.membership ? `:${e.content.membership}` : ''}`);
console.log('incremental after join:', JSON.stringify(tl(inc.rooms?.[room])), 'keys:', Object.keys(inc.rooms?.[room] ?? {}).join(','), 'state types:', JSON.stringify((inc.rooms?.[room]?.required_state ?? []).map((e) => e.type)), 'prev_batch:', inc.rooms?.[room]?.prev_batch);
const fresh = await sss({ ...list, room_subscriptions: { [room]: { timeline_limit: 50, required_state: [['*', '*']] } } });
console.log('fresh connection:', JSON.stringify(tl(fresh.rooms?.[room])));
const msgs = await call('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=20`, undefined, b.access_token);
console.log('/messages:', JSON.stringify((msgs.chunk ?? []).map((e) => e.type + (e.content?.body ? ':' + e.content.body : ''))));
// Вариант 2: комната уже в списке (вошёл раньше), подписка на неё добавляется в текущем соединении — так клиент открывает чат.
const f2 = await sss(list);
console.log('list only, timeline:', JSON.stringify(tl(f2.rooms?.[room])));
const s2 = await sss({ ...list, room_subscriptions: { [room]: { timeline_limit: 50, required_state: [['*', '*']] } } }, f2.pos);
console.log('new subscription on existing connection:', JSON.stringify(tl(s2.rooms?.[room])), 'state types:', (s2.rooms?.[room]?.required_state ?? []).length, 'initial:', s2.rooms?.[room]?.initial);
// Вариант 3: обычная синхронизация, приглашение → вход в текущем соединении (фильтр как у веб-клиента).
{
  const t3 = Date.now();
  const c = await user(`probe-hc-${t3}`);
  const room3 = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat', invite: [c.user_id] }, a.access_token)).room_id;
  await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room3)}/send/m.room.message/m3`, { msgtype: 'm.text', body: 'до входа (classic)' }, a.access_token);
  const filter = encodeURIComponent(JSON.stringify({ room: { state: { lazy_load_members: true }, timeline: { limit: 30, lazy_load_members: true } } }));
  const s1 = await call('GET', `/_matrix/client/v3/sync?filter=${filter}&timeout=0`, undefined, c.access_token);
  await call('POST', `/_matrix/client/v3/join/${encodeURIComponent(room3)}`, {}, c.access_token);
  const s2 = await call('GET', `/_matrix/client/v3/sync?filter=${filter}&timeout=0&since=${s1.next_batch}`, undefined, c.access_token);
  const j = s2.rooms?.join?.[room3];
  console.log('classic after join:', JSON.stringify((j?.timeline?.events ?? []).map((e) => e.type + (e.content?.body ? ':' + e.content.body : e.content?.membership ? ':' + e.content.membership : ''))), 'limited:', j?.timeline?.limited, 'state:', (j?.state?.events ?? []).length);
}
