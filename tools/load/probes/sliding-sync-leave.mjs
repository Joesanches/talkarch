// Что отдаёт Simplified Sliding Sync пользователю, которого вывели из комнаты. Аргументы: адрес сервера, токен регистрации.
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
const a = await user(`probe-a-${t}`), b = await user(`probe-b-${t}`);
const room = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat', invite: [b.user_id] }, a.access_token)).room_id;
await call('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, b.access_token);
await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/m1`, { msgtype: 'm.text', body: 'до архива' }, a.access_token);
const sss = (body, since) => call('POST', `/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0${since ? `&pos=${since}` : ''}`, body, b.access_token);
const body = { lists: { all: { ranges: [[0, 99]], timeline_limit: 3, required_state: [['ru.vendor.case.archive', ''], ['m.room.member', '$ME']] } } };
const first = await sss(body);
await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/ru.vendor.case.archive/`, { status: 'archived' }, a.access_token);
await call('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`, { user_id: b.user_id, reason: 'архив' }, a.access_token);
const inc = await sss(body, first.pos);
console.log('incremental:', JSON.stringify(inc.rooms?.[room] ?? null).slice(0, 800), 'lists:', JSON.stringify(inc.lists));
const fresh = await sss(body);
console.log('fresh:', JSON.stringify(fresh.rooms?.[room] ?? null).slice(0, 800), 'lists:', JSON.stringify(fresh.lists));
const forget = await call('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/forget`, {}, b.access_token);
const after = await sss(body);
console.log('forget:', JSON.stringify(forget), 'after forget:', JSON.stringify(after.rooms?.[room] ?? null).slice(0, 200));
