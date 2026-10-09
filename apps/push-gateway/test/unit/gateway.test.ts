import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@konsilium/protocol';
import { PUSH_EXTERNAL_KEY, PushAppId, PushSignal, PushSound } from '@konsilium/protocol/push';
import { ack, connect, newPushkey, notify, startGateway } from './helpers.ts';

type Gateway = Awaited<ReturnType<typeof startGateway>>;
let gw: Gateway | null = null;
afterEach(async () => {
  await gw?.close();
  gw = null;
});

const device = (pushkey: string, opts: { sound?: string; external?: unknown } = {}) => ({
  app_id: PushAppId.Android,
  pushkey,
  pushkey_ts: 1,
  data: { ...(opts.external === null ? {} : { [PUSH_EXTERNAL_KEY]: opts.external ?? { provider: 'rustore', token: 'rustore-token-1' } }) },
  tweaks: opts.sound ? { sound: opts.sound } : {},
});
const message = (devices: unknown[], extra: Record<string, unknown> = {}) => ({
  notification: { event_id: '$ev1', room_id: '!room:konsilium.test', prio: 'low', counts: { unread: 2 }, devices, ...extra },
});

describe('прямое соединение', () => {
  it('сигнал без содержимого приходит по прямому соединению; после подтверждения внешний канал не трогается', async () => {
    gw = await startGateway('all');
    const key = newPushkey();
    const conn = await connect(gw.base, key);
    // Сервер с включённой передачей содержимого прислал бы и текст с именами — шлюз их не пересылает.
    const res = notify(gw.base, message([device(key)], { content: { body: 'Пациентка Н***, биопсия' }, sender_display_name: 'Смирнова А. В.' }));
    const signal = PushSignal.parse(await conn.next('push'));
    expect(signal).toMatchObject({ kind: 'message', prio: 'low', room_id: '!room:konsilium.test', event_id: '$ev1', unread: 2 });
    expect(JSON.stringify(signal)).not.toMatch(/Пациентка|Смирнова/);
    expect((await ack(gw.base, key, signal.id)).status).toBe(204);
    expect(await (await res).json()).toEqual({ rejected: [] });
    expect(gw.providers.rustore.sent).toHaveLength(0);
    expect(gw.counts.direct).toBe(1);
    conn.close();
  });

  it('нет подтверждения — соединение закрывается, сигнал уходит внешним каналом', async () => {
    gw = await startGateway('all', { ackTimeoutMs: 150 });
    const key = newPushkey();
    const conn = await connect(gw.base, key);
    const res = await notify(gw.base, message([device(key)]));
    expect(await res.json()).toEqual({ rejected: [] });
    await conn.done;
    expect(conn.ended()).toBe(true);
    expect(gw.providers.rustore.sent).toEqual([{ token: 'rustore-token-1', signal: expect.objectContaining({ kind: 'message', event_id: '$ev1' }) }]);
    expect(((await (await fetch(`${gw.base}/healthz`)).json()) as { connected: number }).connected).toBe(0);
  });

  it('подтверждение чужим pushkey не засчитывается; без pushkey соединения нет; новое соединение устройства закрывает прежнее', async () => {
    gw = await startGateway('off', { ackTimeoutMs: 300 });
    const key = newPushkey();
    expect((await fetch(`${gw.base}/v1/connect`, { headers: { authorization: 'Bearer short' } })).status).toBe(401);
    const first = await connect(gw.base, key);
    const second = await connect(gw.base, key);
    await first.done;
    expect(first.ended()).toBe(true);
    const res = notify(gw.base, message([device(key, { external: null })]));
    const signal = PushSignal.parse(await second.next('push'));
    expect((await ack(gw.base, newPushkey(), signal.id)).status).toBe(404);
    expect((await ack(gw.base, key, signal.id)).status).toBe(204);
    await res;
    expect(gw.counts.direct).toBe(1);
    second.close();
  });
});

describe('внешняя доставка по политике организации', () => {
  it('off — никуда; critical — только находки и звонки, с высоким приоритетом; all — и сообщения, и значок', async () => {
    gw = await startGateway('off');
    await notify(gw.base, message([device(newPushkey(), { sound: PushSound.Critical })]));
    expect(gw.providers.rustore.sent).toHaveLength(0);
    expect(gw.counts.dropped).toBe(1);
    await gw.close();

    gw = await startGateway('critical');
    await notify(gw.base, message([device(newPushkey())]));
    expect(gw.providers.rustore.sent).toHaveLength(0);
    await notify(gw.base, message([device(newPushkey(), { sound: PushSound.Critical })]));
    await notify(gw.base, message([device(newPushkey(), { sound: PushSound.Call })]));
    await notify(gw.base, message([device(newPushkey())], { type: EventType.CallInvite }));
    expect(gw.providers.rustore.sent.map((s) => [s.signal.kind, s.signal.prio])).toEqual([
      ['critical', 'high'],
      ['call', 'high'],
      ['call', 'high'],
    ]);
    await gw.close();

    gw = await startGateway('all');
    await notify(gw.base, message([device(newPushkey())], { prio: 'high' }));
    // Прочитал на другом устройстве — сервер присылает только счётчик: значок на иконке.
    await notify(gw.base, { notification: { counts: { unread: 0 }, devices: [device(newPushkey())] } });
    expect(gw.providers.rustore.sent.map((s) => [s.signal.kind, s.signal.prio, s.signal.unread])).toEqual([
      ['message', 'high', 2],
      ['badge', 'low', 0],
    ]);
  });

  it('внешний сервис счёл токен недействительным — pushkey в rejected; сервис без ключей и чужой формат — не отправляем', async () => {
    gw = await startGateway('all');
    gw.providers.rustore.result = 'invalid';
    const dead = newPushkey();
    const res = await notify(gw.base, message([device(dead), device(newPushkey(), { external: { provider: 'fcm', token: 'fcm-token-1' } }), device(newPushkey(), { external: { provider: 'pager' } })]));
    expect(await res.json()).toEqual({ rejected: [dead] });
    expect(gw.counts.dropped).toBe(3);
  });

  it('запрос не по Matrix Push Gateway API — 400', async () => {
    gw = await startGateway('off');
    expect((await notify(gw.base, { notification: { devices: [] } })).status).toBe(400);
    expect((await notify(gw.base, { hello: 1 })).status).toBe(400);
  });
});
