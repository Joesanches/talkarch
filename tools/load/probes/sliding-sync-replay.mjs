// Повтор запроса с тем же pos (docs/11-load-test.md, 7.4): matrix-js-sdk прерывает запрос в полёте при каждой смене
// подписок и окна и отправляет новый с тем же pos. 1) ответ с событием «потерян», запрос с тем же pos повторён — пришло ли
// событие снова? 2) новая подписка на комнату без новых событий при timeout=5000 — ответ сразу или через 5 с?
// 3) то же без timeout. Аргументы: адрес сервера, токен регистрации (Tuwunel: registration_token).
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
const a = await user(`probe-ra-${t}`), b = await user(`probe-rb-${t}`);
const room = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat', invite: [b.user_id] }, a.access_token)).room_id;
await call('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, b.access_token);
const sss = (body, pos, timeout) =>
  call('POST', `/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?${[pos && `pos=${pos}`, timeout !== undefined && `timeout=${timeout}`].filter(Boolean).join('&')}`, body, b.access_token);
const list = { lists: { all: { ranges: [[0, 19]], timeline_limit: 3, required_state: [['m.room.name', '']] } } };
const bodies = (r) => (r?.rooms?.[room]?.timeline ?? []).map((e) => e.content?.body).filter(Boolean);

const first = await sss(list, undefined, 0);
await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/m1`, { msgtype: 'm.text', body: 'первое' }, a.access_token);
const lost = await sss(list, first.pos, 0);
const again = await sss(list, first.pos, 0);
console.log('1) ответ:', JSON.stringify(bodies(lost)), 'pos', first.pos, '→', lost.pos, '| повтор с тем же pos:', JSON.stringify(bodies(again)), 'pos →', again.pos);

const sub = { ...list, room_subscriptions: { [room]: { timeline_limit: 10, required_state: [['m.room.power_levels', '']] } } };
let t0 = Date.now();
const s1 = await sss(sub, again.pos, 5000);
console.log('2) новая подписка, timeout=5000:', Date.now() - t0, 'мс; состояние:', (s1.rooms?.[room]?.required_state ?? []).length, 'лента:', (s1.rooms?.[room]?.timeline ?? []).length);
const sub2 = { ...list, room_subscriptions: { [room]: { timeline_limit: 10, required_state: [['m.room.create', '']] } } };
t0 = Date.now();
const s2 = await sss(sub2, s1.pos);
console.log('3) изменённая подписка без timeout:', Date.now() - t0, 'мс; состояние:', (s2.rooms?.[room]?.required_state ?? []).length);
