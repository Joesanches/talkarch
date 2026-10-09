// Проба долговечности: N сообщений по одному в новую комнату. Аргументы: адрес сервера, токен регистрации, N.
const [hs, token, n] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 200)];
const call = async (method, path, body, auth) => {
  const r = await fetch(hs + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
const user = `probe-${Date.now()}`;
const s = await call('POST', '/_matrix/client/v3/register', { username: user, password: 'dev-only-probe-1' });
const reg = await call('POST', '/_matrix/client/v3/register', { username: user, password: 'dev-only-probe-1', auth: { type: 'm.login.registration_token', token, session: s.session } });
const room = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat' }, reg.access_token)).room_id;
await new Promise((r) => setTimeout(r, 1000));
console.log('START');
const t0 = performance.now();
for (let i = 0; i < n; i++) await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/p${i}`, { msgtype: 'm.text', body: `probe ${i}` }, reg.access_token);
console.log(`DONE ${n} msgs in ${Math.round(performance.now() - t0)} ms`);
