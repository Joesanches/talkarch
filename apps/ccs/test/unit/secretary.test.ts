import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, MsgType } from '@konsilium/protocol';
import { firstJsonObject, grounded, parseLlmSections, protocolBody, templateSections, type LlmClient } from '../../src/secretary.ts';
import { LIS_CASE, mx, setup, waitFor, type Harness } from './harness.ts';

const segs = [
  { i: 0, speaker: mx('smirnova'), name: 'Смирнова А. В.', start_ms: 1000, end_ms: 6000, text: 'по иммуногистохимии рецепторы эстрогена положительные' },
  { i: 1, speaker: mx('smirnova'), name: 'Смирнова А. В.', start_ms: 6500, end_ms: 9000, text: 'her2 отрицательный' },
  { i: 2, speaker: mx('kolesnikov'), name: 'Колесников Д. А.', start_ms: 10000, end_ms: 15000, text: 'предлагаю гормональную терапию и контроль через три месяца' },
];

describe('черновик протокола', () => {
  it('ответ LLM: JSON после размышлений и в блоке кода; утверждения без ссылок отбрасываются', () => {
    const text = '<think>думаю</think>```json\n' + JSON.stringify({
      purpose: [{ text: 'Определить тактику лечения', refs: [] }],
      clinical: [{ text: 'Рецепторы эстрогена положительные, HER2 отрицательный', refs: [1, 0, 1, 99] }],
      discussion: [
        { speaker: 'Колесников Д. А.', text: 'Гормональная терапия', refs: [2] },
        { speaker: 'Колесников Д. А.', text: 'Гормональная терапия', refs: [2] },
      ],
      decision: [
        { text: 'Гормональная терапия, контроль через 3 месяца', refs: [2] },
        // Ссылка есть, но в стенограмме этого не говорили — не попадает.
        { text: 'Лучевая терапия на область молочной железы', refs: [2] },
      ],
    }) + '\n```';
    const s = parseLlmSections(text, segs)!;
    expect(s.purpose).toEqual([]); // без подтверждения стенограммой
    expect(s.clinical).toEqual([{ text: 'Рецепторы эстрогена положительные, HER2 отрицательный', refs: [0, 1] }]);
    expect(s.discussion).toHaveLength(1); // повтор склеен
    expect(s.decision).toEqual([{ text: 'Гормональная терапия, контроль через 3 месяца', refs: [2] }]);
    expect(parseLlmSections('не JSON', segs)).toBeNull();
    expect(parseLlmSections('{"decision":[{"text":"x","refs":[]}]}', segs)).toBeNull();
  });

  it('позиция участника опирается только на его реплики; JSON — первый целый объект', () => {
    const answer = 'Вот ответ: {"discussion":[{"speaker":"Смирнова А. В.","text":"Предлагаю гормональную терапию","refs":[2]},{"speaker":"Смирнова А. В.","text":"Рецепторы эстрогена положительные {ER+}","refs":[0,2]}]} и ещё {"x":1}';
    const s = parseLlmSections(answer, segs)!;
    expect(s.discussion).toEqual([{ speaker: 'Смирнова А. В.', text: 'Рецепторы эстрогена положительные {ER+}', refs: [0] }]);
    expect(firstJsonObject('{"a":"}"} {"b":2}')).toEqual({ a: '}' });
    expect(firstJsonObject('{битый} {"ok":true}')).toEqual({ ok: true });
    expect(firstJsonObject('нет')).toBeUndefined();
  });

  it('сверка утверждения со стенограммой по основам слов', () => {
    expect(grounded('Предложена гормонотерапия, контроль через три месяца', ['предлагаю гормональную терапию и контроль через три месяца'])).toBe(true);
    expect(grounded('Биопсия молочной железы', ['по иммуногистохимии рецепторы эстрогена положительные'])).toBe(false);
    expect(grounded('да', ['да'])).toBe(false); // нет значимых слов
  });

  it('без LLM: позиции участников из подряд идущих реплик, решение пустое', () => {
    const s = templateSections(segs);
    expect(s.discussion).toEqual([
      { speaker: 'Смирнова А. В.', text: 'по иммуногистохимии рецепторы эстрогена положительные her2 отрицательный', refs: [0, 1] },
      { speaker: 'Колесников Д. А.', text: 'предлагаю гормональную терапию и контроль через три месяца', refs: [2] },
    ]);
    expect(s.decision).toEqual([]);
  });

  it('текст черновика для любых клиентов', () => {
    const body = protocolBody({
      kind: 'consilium_protocol',
      status: 'draft',
      generated_by: 'template',
      meeting: { date: '08.10.2026', start: '10:05', end: '10:17', form: 'remote' },
      participants: [{ name: 'Смирнова А. В.', mxid: mx('smirnova'), role: 'патоморфолог' }],
      case: { connector: 'lis', case_id: LIS_CASE, title: 'Биопсия', patient: 'Н*** О. В.' },
      sections: templateSections(segs),
    });
    expect(body).toMatch(/^ЧЕРНОВИК ПРОТОКОЛА КОНСИЛИУМА \(ИИ\)/);
    expect(body).toContain('Случай: Г26-04512 · Биопсия · пациент Н*** О. В.');
    expect(body).toContain('— Колесников Д. А.: предлагаю гормональную терапию и контроль через три месяца [2]');
    expect(body).toContain('Решение: —');
  });
});

describe('ИИ-«Секретарь» в сервисе контекста', () => {
  let h: Harness;
  let agent: FastifyInstance;
  const received: Array<{ method: string; url: string; body: any }> = [];
  let agentLost = false;

  async function withAgent(llm: LlmClient | null) {
    received.length = 0;
    agent = Fastify();
    agent.post('/sessions', async (req) => {
      received.push({ method: 'POST', url: req.url, body: req.body });
      return { ok: true };
    });
    agentLost = false;
    agent.delete('/sessions/:id', async (req, reply) => {
      received.push({ method: 'DELETE', url: req.url, body: null });
      return agentLost ? reply.code(404).send({ error: 'Нет такой сессии' }) : { ok: true };
    });
    await agent.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
    h = await setup({ ai: { profile: 'cpu', secretaryUrl: url, secretaryToken: 'secretary-token-0123456789' }, llm });
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    h.matrix.join(roomId, mx('smirnova'));
    return roomId as string;
  }

  afterEach(async () => {
    await h?.close();
    await agent?.close();
  });

  const api = (user: string, body: object) =>
    h.app.inject({ method: 'POST', url: '/api/v1/calls/secretary', headers: { authorization: `Bearer tok-${user}` }, payload: body });
  const result = (sessionId: string, token = 'secretary-token-0123456789') =>
    h.app.inject({
      method: 'POST',
      url: `/internal/v1/secretary/sessions/${sessionId}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        session_id: sessionId,
        started_at: '2026-10-08T07:05:00Z',
        ended_at: '2026-10-08T07:17:00Z',
        participants: [{ identity: mx('smirnova'), name: 'Смирнова А. В.' }, { identity: mx('kolesnikov'), name: 'Колесников Д. А.' }],
        segments: segs,
        asr: { engine: 'vosk' },
      },
    });

  it('выключен политикой — 501', async () => {
    h = await setup();
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    h.matrix.join(roomId, mx('smirnova'));
    expect((await api('smirnova', { roomId, action: 'start' })).statusCode).toBe(501);
    const callToken = await h.app.inject({ method: 'POST', url: '/api/v1/calls/token', headers: { authorization: 'Bearer tok-smirnova' }, payload: { roomId } });
    expect(callToken.json().secretary).toBeNull();
  });

  it('запуск: агент получает токен «только слушать», все видят индикатор и уведомление; повтор — 409; посторонний — 403', async () => {
    const roomId = await withAgent(null);
    // Токен звонка сообщает клиенту, что кнопка стенограммы доступна.
    const callToken = await h.app.inject({ method: 'POST', url: '/api/v1/calls/token', headers: { authorization: 'Bearer tok-smirnova' }, payload: { roomId } });
    expect(callToken.json().secretary).toEqual({ eta_minutes: 30 });
    const res = await api('smirnova', { roomId, action: 'start' });
    expect(res.json()).toEqual({ status: 'started', eta_minutes: 30 });
    const call = received[0]!.body;
    expect(call.callback_url).toMatch(/\/internal\/v1\/secretary\/sessions\/[0-9a-f-]+\/result$/);
    const grant = JSON.parse(Buffer.from(call.token.split('.')[1], 'base64url').toString());
    expect(grant).toMatchObject({ name: 'Секретарь (запись речи)', video: { roomJoin: true, canPublish: false, canSubscribe: true } });
    expect(await h.matrix.getState(roomId, EventType.Call, 'main')).toMatchObject({ transcription: { started_by: mx('smirnova'), profile: 'cpu' } });
    expect(h.matrix.messages(roomId).at(-1)!.content.body).toMatch(/^Включена стенограмма/);
    expect((await api('smirnova', { roomId, action: 'start' })).statusCode).toBe(409);
    expect((await api('outsider', { roomId, action: 'start' })).statusCode).toBe(403);

    expect((await api('smirnova', { roomId, action: 'stop' })).json()).toEqual({ status: 'stopping' });
    expect(received[1]).toMatchObject({ method: 'DELETE', url: expect.stringMatching(/^\/sessions\//) });
  });

  it('результат: стенограмма в чат, индикатор снят, черновик от LLM со ссылками и данными из систем', async () => {
    const llm: LlmClient = {
      model: 'test-llm',
      complete: async () =>
        JSON.stringify({ clinical: [{ text: 'РЭ положительные, HER2 отрицательный', refs: [0, 1] }], decision: [{ text: 'Гормональная терапия, контроль через 3 месяца', refs: [2] }] }),
    };
    const roomId = await withAgent(llm);
    await api('smirnova', { roomId, action: 'start' });
    const sessionId = received[0]!.body.session_id as string;

    expect((await result(sessionId, 'wrong-token-0123456789abc')).statusCode).toBe(401);
    const res = await result(sessionId);
    expect(res.statusCode).toBe(202);
    expect((await h.matrix.getState<Record<string, unknown>>(roomId, EventType.Call, 'main'))?.transcription).toBeUndefined();

    const transcript = h.matrix.messages(roomId).find((m) => m.content.msgtype === MsgType.Transcript)!;
    expect(transcript.content.body).toContain('Колесников Д. А.: предлагаю гормональную терапию');
    const draft = await waitFor(() => h.matrix.messages(roomId).find((m) => m.content.msgtype === MsgType.Report));
    const r = draft.content[MsgType.Report] as Record<string, any>;
    expect(r).toMatchObject({
      generated_by: 'llm',
      model: 'test-llm',
      transcript_event_id: res.json().transcript_event_id,
      case: { case_id: LIS_CASE, patient: 'Н*** О. В.' },
      sections: { decision: [{ text: 'Гормональная терапия, контроль через 3 месяца', refs: [2] }] },
    });
    expect(r.participants).toEqual(
      expect.arrayContaining([
        { mxid: mx('smirnova'), name: 'Смирнова А. В.', role: 'патоморфолог' },
        { mxid: mx('kolesnikov'), name: 'Колесников Д. А.', role: 'лечащий врач' },
      ]),
    );
    expect(draft.content.body).not.toMatch(/Нестерова/);
    // Повторный результат той же сессии не принимается.
    expect((await result(sessionId)).statusCode).toBe(404);
  });

  it('агент потерял сессию (перезапуск) — «Остановить» снимает индикатор и сообщает, что записи нет', async () => {
    const roomId = await withAgent(null);
    await api('smirnova', { roomId, action: 'start' });
    agentLost = true;
    expect((await api('smirnova', { roomId, action: 'stop' })).statusCode).toBe(200);
    expect((await h.matrix.getState<Record<string, unknown>>(roomId, EventType.Call, 'main'))?.transcription).toBeUndefined();
    expect(h.matrix.messages(roomId).at(-1)!.content.body).toMatch(/^Стенограмма прервана/);
    // Можно включить заново.
    agentLost = false;
    expect((await api('smirnova', { roomId, action: 'start' })).statusCode).toBe(200);
  });

  it('сервис перезапускался посреди стенограммы — «Остановить» снимает оставшийся индикатор; без индикатора — 409', async () => {
    const roomId = await withAgent(null);
    expect((await api('smirnova', { roomId, action: 'stop' })).statusCode).toBe(409);
    // Индикатор от прошлого процесса сервиса: сессии в памяти уже нет.
    await h.matrix.sendState(roomId, EventType.Call, 'main', {
      call_id: 'main',
      kind: 'consilium',
      started_by: mx('smirnova'),
      started_at: '2026-10-09T10:00:00Z',
      transcription: { started_by: mx('smirnova'), started_at: '2026-10-09T10:00:00Z', profile: 'cpu' },
    });
    expect((await api('smirnova', { roomId, action: 'stop' })).statusCode).toBe(200);
    expect((await h.matrix.getState<Record<string, unknown>>(roomId, EventType.Call, 'main'))?.transcription).toBeUndefined();
    expect(h.matrix.messages(roomId).at(-1)!.content.body).toBe('Стенограмма прервана: сервис перезапускался, запись не сохранена.');
  });

  it('LLM недоступна — черновик по шаблону', async () => {
    const roomId = await withAgent({ model: 'down', complete: async () => Promise.reject(new Error('ECONNREFUSED')) });
    await api('smirnova', { roomId, action: 'start' });
    await result(received[0]!.body.session_id);
    const draft = await waitFor(() => h.matrix.messages(roomId).find((m) => m.content.msgtype === MsgType.Report));
    expect(draft.content[MsgType.Report]).toMatchObject({ generated_by: 'template', sections: { decision: [] } });
  });
});
