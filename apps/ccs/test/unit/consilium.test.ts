import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, MsgType, RoomType } from '@konsilium/protocol';
import { splitByAgenda } from '../../src/secretary.ts';
import { LIS_CASE, mx, setup, waitFor, type Harness } from './harness.ts';

const T0 = Date.parse('2026-10-09T11:00:00Z');
const seg = (i: number, login: string, name: string, at: number, text: string) => ({ i, speaker: mx(login), name, start_ms: at - T0, end_ms: at - T0 + 3000, text });

describe('деление стенограммы по повестке', () => {
  it('фрагмент относится к случаю последней отметки до его начала; до первой отметки — к случаю на момент включения', () => {
    const segments = [seg(0, 'kolesnikov', 'К', T0 + 1000, 'а'), seg(1, 'orlov', 'О', T0 + 61_000, 'б'), seg(2, 'smirnova', 'С', T0 + 121_000, 'в'), seg(3, 'belova', 'Б', T0 + 125_000, 'г')];
    const marks = [
      { index: 2, at: T0 + 120_000 },
      { index: 0, at: T0 - 5000 },
      { index: 1, at: T0 + 60_000 },
    ];
    expect(splitByAgenda(segments, new Date(T0).toISOString(), marks).map((s) => s.case)).toEqual([0, 1, 2, 2]);
    expect(splitByAgenda(segments, new Date(T0).toISOString(), [{ index: 1, at: T0 + 500_000 }]).map((s) => s.case)).toEqual([1, 1, 1, 1]);
  });
});

describe('консилиум в сервисе контекста', () => {
  let h: Harness;
  let agent: FastifyInstance | undefined;
  const sessions: string[] = [];

  afterEach(async () => {
    await h?.close();
    await agent?.close();
    agent = undefined;
  });

  /** Стенд с агентом «Секретаря», консилиум песочницы отправлен; комната консилиума — по псевдониму. */
  async function withConsilium() {
    sessions.length = 0;
    agent = Fastify();
    agent.post('/sessions', async (req) => {
      sessions.push((req.body as { session_id: string }).session_id);
      return { ok: true };
    });
    agent.delete('/sessions/:id', async () => ({ ok: true }));
    await agent.listen({ host: '127.0.0.1', port: 0 });
    h = await setup({ ai: { profile: 'cpu', secretaryUrl: `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`, secretaryToken: 'secretary-token-0123456789' } });
    const data = h.mock.consiliumData(h.mock.consilia.get('lis')![0]!);
    const res = await h.mock.pushConsilia();
    expect(res.lis!.body.results).toEqual([expect.objectContaining({ status: 'accepted' })]);
    const roomId = (await h.service.consilia.roomFor('lis', data.consilium_id))!;
    expect(roomId).toBeTruthy();
    return { roomId, data };
  }

  const event = (connector: 'lis' | 'ris', id: string, data: unknown) => h.events(connector, { specversion: '1.0', id, source: connector, type: 'ru.vendor.consilium.upserted', data });

  it('событие МИС: комната консилиума с повесткой из ЛИС и РИС, состав приглашён, ведущим — уровень 50', async () => {
    const { roomId, data } = await withConsilium();
    const room = h.matrix.rooms.get(roomId)!;
    expect(room.req.creation_content).toEqual({ type: RoomType.Consilium });
    expect(room.req.name).toBe(data.title);
    const c = (await h.matrix.getState<Record<string, any>>(roomId, EventType.Consilium))!;
    expect(c.members[mx('belova')]).toEqual({ role: 'chair', title: 'заведующая онкологическим отделением' });
    expect(c.members[mx('gusev')]).toEqual({ role: 'member', title: 'химиотерапевт, НМИЦ', remote: true });
    // Случаи — из систем-источников: Г26-04530 сервис получил обратным вызовом ЛИС, A26-118737 — из события РИС.
    expect(c.agenda.map((a: any) => [a.connector, a.case_id, a.patient.masked, a.presenter])).toEqual([
      ['lis', LIS_CASE, 'Н*** О. В.', mx('kolesnikov')],
      ['ris', 'A26-118737', 'Г*** Е. В.', mx('orlov')],
      ['lis', 'Г26-04530', 'Л*** И. С.', mx('smirnova')],
    ]);
    expect(await h.matrix.getState(roomId, EventType.ConsiliumCurrent)).toEqual({ index: 0 });
    for (const u of ['belova', 'petrov', 'kolesnikov', 'smirnova', 'orlov', 'gusev']) expect(await h.matrix.getMembership(roomId, mx(u))).toBe('invite');
    const pl = room.req.power_level_content_override as Record<string, any>;
    expect(pl.users).toEqual({ [mx('belova')]: 50, [mx('petrov')]: 50 });
    expect(pl.events).toMatchObject({ [EventType.ConsiliumCurrent]: 50, [EventType.ReportStatus]: 50, [EventType.Consilium]: 100 });

    // Повтор той же версии — без изменений; старая версия — stale.
    expect((await event('lis', 'again', data)).json().results[0].status).toBe('accepted');
    expect((await event('lis', 'old', { ...data, version: 0 })).json().results[0].status).toBe('stale');
    expect(h.matrix.createCalls).toBe(1);
  });

  it('новая версия: секретарь сменился, участник исключён; без председателя и с неизвестным случаем — rejected', async () => {
    const { roomId, data } = await withConsilium();
    const members = data.members.filter((m) => m.user.login !== 'gusev').map((m) => (m.user.login === 'petrov' ? { ...m, role: 'member' } : m.user.login === 'kolesnikov' ? { ...m, role: 'secretary' } : m));
    expect((await event('lis', 'v2', { ...data, version: 2, members })).json().results[0].status).toBe('accepted');
    expect(await h.matrix.getMembership(roomId, mx('gusev'))).toBe('leave');
    expect(((await h.matrix.getState<Record<string, any>>(roomId, 'm.room.power_levels'))!).users).toEqual({ [mx('belova')]: 50, [mx('kolesnikov')]: 50 });

    const noChair = await event('lis', 'v3', { ...data, version: 3, members: members.filter((m) => m.role !== 'chair') });
    expect(noChair.json().results[0]).toMatchObject({ status: 'rejected', detail: expect.stringContaining('председатель') });
    const unknown = await event('lis', 'v4', { ...data, version: 4, agenda: [{ case_id: 'Г26-99999' }] });
    expect(unknown.json().results[0]).toMatchObject({ status: 'rejected', detail: expect.stringContaining('Г26-99999') });
  });

  it('стенограмма консилиума делится по отметкам текущего случая; черновик — на каждый обсуждённый случай, с ролями', async () => {
    const { roomId } = await withConsilium();
    for (const u of ['belova', 'petrov', 'kolesnikov', 'smirnova', 'orlov']) h.matrix.join(roomId, mx(u));
    const start = await h.app.inject({ method: 'POST', url: '/api/v1/calls/secretary', headers: { authorization: 'Bearer tok-belova' }, payload: { roomId, action: 'start' } });
    expect(start.statusCode).toBe(200);
    const sessionId = sessions[0]!;
    const t0 = Date.now();
    // Председатель переключает случаи: сначала третий, потом второй (порядок — как решили на консилиуме).
    await h.transaction('t1', [
      { event_id: '$cur1', room_id: roomId, sender: mx('belova'), type: EventType.ConsiliumCurrent, state_key: '', content: { index: 2 }, origin_server_ts: t0 + 60_000 },
      { event_id: '$cur2', room_id: roomId, sender: mx('belova'), type: EventType.ConsiliumCurrent, state_key: '', content: { index: 1 }, origin_server_ts: t0 + 120_000 },
    ]);
    const at = (s: number) => t0 + s * 1000;
    const startedAt = new Date(t0).toISOString();
    const segments = [
      { i: 0, speaker: mx('kolesnikov'), name: 'Колесников Д. А.', start_ms: at(5) - t0, end_ms: at(9) - t0, text: 'опухоль левой молочной железы около двух сантиметров' },
      { i: 1, speaker: mx('belova'), name: 'Белова Л. Р.', start_ms: at(20) - t0, end_ms: at(25) - t0, text: 'решение биопсия лимфоузла и неоадъювантная терапия' },
      { i: 2, speaker: mx('smirnova'), name: 'Смирнова А. В.', start_ms: at(70) - t0, end_ms: at(75) - t0, text: 'аденокарцинома толстой кишки метастазы в двух лимфоузлах' },
    ];
    const res = await h.app.inject({
      method: 'POST',
      url: `/internal/v1/secretary/sessions/${sessionId}/result`,
      headers: { authorization: 'Bearer secretary-token-0123456789' },
      payload: { session_id: sessionId, started_at: startedAt, ended_at: new Date(at(140)).toISOString(), participants: [], segments, asr: { engine: 'vosk' } },
    });
    expect(res.statusCode).toBe(202);
    const transcript = h.matrix.messages(roomId).find((m) => m.content.msgtype === MsgType.Transcript)!;
    expect((transcript.content[MsgType.Transcript] as any).segments.map((s: any) => s.case)).toEqual([0, 0, 2]);

    const drafts = await waitFor(() => {
      const d = h.matrix.messages(roomId).filter((m) => m.content.msgtype === MsgType.Report);
      return d.length === 2 ? d : undefined;
    });
    const first = drafts[0]!.content[MsgType.Report] as Record<string, any>;
    expect(first).toMatchObject({
      status: 'draft',
      generated_by: 'template',
      transcript_event_id: res.json().transcript_event_id,
      case: { connector: 'lis', case_id: LIS_CASE, patient: 'Н*** О. В.' },
      agenda: { index: 0, total: 3, consilium: expect.stringMatching(/^Онкоконсилиум · /) },
      meeting: { form: 'mixed' },
    });
    expect(first.sections.discussion.map((s: any) => s.refs)).toEqual([[0], [1]]);
    expect(first.participants).toEqual(
      expect.arrayContaining([
        { mxid: mx('belova'), name: 'Белова Л. Р.', role: 'председатель, заведующая онкологическим отделением' },
        { mxid: mx('kolesnikov'), name: 'Колесников Д. А.', role: 'докладчик, онколог' },
        { mxid: mx('gusev'), name: mx('gusev'), role: 'химиотерапевт, НМИЦ', remote: true },
      ]),
    );
    expect(drafts[0]!.content.body).toContain('случай 1 из 3');
    expect((drafts[1]!.content[MsgType.Report] as any)).toMatchObject({ agenda: { index: 2 }, case: { case_id: 'Г26-04530' } });
    expect(h.matrix.messages(roomId).at(-1)!.content.body).toBe('Без черновика — по стенограмме обсуждения не было: случай 2 из 3.');
  });

  it('принятие черновика: копия протокола — в чат случая, протокол — в МИС на подпись, итог — рядом с черновиком', async () => {
    const { roomId } = await withConsilium();
    // Черновик сервиса в комнате консилиума (как после стенограммы).
    const draft = {
      msgtype: MsgType.Report,
      body: 'ЧЕРНОВИК',
      [MsgType.Report]: {
        kind: 'consilium_protocol',
        status: 'draft',
        generated_by: 'template',
        transcript_event_id: '$t',
        meeting: { date: '09.10.2026', start: '14:02', end: '14:09', form: 'mixed' },
        participants: [
          { mxid: mx('belova'), name: 'Белова Л. Р.', role: 'председатель' },
          { mxid: mx('kolesnikov'), name: 'Колесников Д. А.', role: 'докладчик, онколог' },
        ],
        case: { connector: 'lis', case_id: LIS_CASE, title: 'Биопсия', patient: 'Н*** О. В.' },
        agenda: { index: 0, total: 3, consilium: 'Онкоконсилиум' },
        sections: { purpose: [], clinical: [], discussion: [{ speaker: 'Колесников Д. А.', text: 'опухоль', refs: [0] }], decision: [{ text: 'Биопсия лимфоузла', refs: [1] }], dissent: [] },
      },
    };
    const draftId = await h.matrix.sendEvent(roomId, 'm.room.message', draft);
    const status = (s: string, id: string) => ({ event_id: id, room_id: roomId, sender: mx('petrov'), type: EventType.ReportStatus, content: { 'm.relates_to': { rel_type: 'm.reference', event_id: draftId }, status: s } });

    // Отклонение — без передачи.
    await h.transaction('r1', [status('rejected', '$rej')]);
    expect(h.mock.protocols.size).toBe(0);

    await h.transaction('a1', [status('accepted', '$acc')]);
    const delivery = await waitFor(() => h.matrix.messages(roomId, EventType.ReportDelivery)[0]);
    expect(delivery.content).toMatchObject({ 'm.relates_to': { event_id: draftId }, status: 'awaiting_signatures', signers: 2, system: 'МИС', protocol_id: expect.stringMatching(/^ПК-/) });
    const sent = [...h.mock.protocols.values()][0]!.request;
    expect(sent).toMatchObject({
      consilium_id: expect.stringMatching(/^OK-/),
      case: { connector: 'lis', case_id: LIS_CASE },
      accepted_by: { mxid: mx('petrov'), login: 'petrov' },
      sections: { decision: [{ text: 'Биопсия лимфоузла' }] },
      chat: { room_id: roomId, event_id: draftId },
    });
    expect(JSON.stringify(sent)).not.toMatch(/Н\*\*\*/); // данные пациента в МИС не уходят — только номер случая

    // Копия — в чате случая: принят, без ссылок на стенограмму консилиума.
    const caseRoom = (await h.service.caseRooms.roomFor({ connector: 'lis', caseId: LIS_CASE }))!;
    const copy = h.matrix.messages(caseRoom).find((m) => m.content.msgtype === MsgType.Report)!;
    const c = copy.content[MsgType.Report] as Record<string, any>;
    expect(c).toMatchObject({ status: 'accepted', accepted: { by: mx('petrov') }, sections: { decision: [{ text: 'Биопсия лимфоузла', refs: [] }] } });
    expect(c.transcript_event_id).toBeUndefined();
    expect(copy.content.body).toMatch(/^ПРОТОКОЛ КОНСИЛИУМА — принят/);

    // Повтор транзакции (Synapse) — ни второй копии, ни второго протокола в МИС.
    await h.transaction('a2', [status('accepted', '$acc2')]);
    expect(h.matrix.messages(caseRoom).filter((m) => m.content.msgtype === MsgType.Report)).toHaveLength(1);
    expect(h.mock.protocols.size).toBe(1);
  });
});
