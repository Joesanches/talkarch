// Сохранность при аварийной остановке: режим send — отправить N сообщений и вывести комнату и токен;
// режим count — посчитать сообщения в комнате. Аргументы: адрес, режим, токен регистрации | комната, N | токен доступа.
const [hs, mode, a3, a4] = process.argv.slice(2);
const call = async (method, path, body, auth) => {
  const r = await fetch(hs + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
if (mode === 'send') {
  const name = `probe-crash-${Date.now()}`;
  const s = await call('POST', '/_matrix/client/v3/register', { username: name, password: 'dev-only-probe-1' });
  const u = await call('POST', '/_matrix/client/v3/register', { username: name, password: 'dev-only-probe-1', auth: { type: 'm.login.registration_token', token: a3, session: s.session } });
  const room = (await call('POST', '/_matrix/client/v3/createRoom', { preset: 'private_chat' }, u.access_token)).room_id;
  let ok = 0;
  for (let i = 0; i < Number(a4); i++) if ((await call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/c${i}`, { msgtype: 'm.text', body: `crash ${i}` }, u.access_token)).event_id) ok++;
  console.log(JSON.stringify({ room, token: u.access_token, acknowledged: ok }));
} else {
  let n = 0, from = '';
  for (;;) {
    const r = await call('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(a3)}/messages?dir=b&limit=500${from ? `&from=${from}` : ''}`, undefined, a4);
    n += (r.chunk ?? []).filter((e) => e.type === 'm.room.message').length;
    if (!r.end || !(r.chunk ?? []).length) break;
    from = r.end;
  }
  console.log(JSON.stringify({ stored: n }));
}
