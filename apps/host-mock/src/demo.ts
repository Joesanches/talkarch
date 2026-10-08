/**
 * Демо-страница «РИС» песочницы: рабочий список, вьюер и встроенный чат исследования через SDK «Консилиума».
 * Это пример для команды РИС: ровно так подключается /embed/v1/embed.js. Все данные вымышлены.
 */
import type { CaseSnapshot } from '@konsilium/protocol/integration';

export interface DemoStudy {
  snapshot: CaseSnapshot;
  patientName: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function renderRisDemo(chatUrl: string, studies: DemoStudy[]): string {
  const rows = studies
    .map((s, i) => {
      const prio = s.snapshot.priority === 'cito' ? '<span class="chip cito">CITO</span>' : s.snapshot.priority === 'urgent' ? '<span class="chip urgent">Срочно</span>' : '';
      const time = new Date(s.snapshot.updated_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      return `<tr data-i="${i}" data-case="${esc(s.snapshot.case_id)}" tabindex="0"${i === 0 ? ' class="on"' : ''}>
        <td class="t">${time}</td><td class="mono">${esc(s.snapshot.case_id)}</td>
        <td>${esc(s.patientName)}<div class="sub">${esc(s.snapshot.title)}</div></td>
        <td>${prio}</td><td class="badge-cell"><span class="badge" aria-label="Непрочитанные сообщения"></span></td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>РИС · рабочий список (песочница)</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #16202B; background: #EEF1F5; display: grid; grid-template-rows: auto 1fr; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #24303D; color: #fff; }
  header b { font-size: 15px; }
  header .note { margin-left: auto; font-size: 12.5px; color: #B9C6D3; }
  main { display: grid; grid-template-columns: minmax(320px, 420px) minmax(0, 1fr) 400px; gap: 10px; padding: 10px; min-height: 0; }
  section { background: #fff; border-radius: 10px; overflow: hidden; min-height: 0; display: flex; flex-direction: column; }
  h2 { margin: 0; padding: 10px 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #5F6B7A; border-bottom: 1px solid #E1E7ED; }
  .list { overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  col.c-time { width: 52px; } col.c-acc { width: 104px; } col.c-prio { width: 76px; } col.c-badge { width: 48px; }
  td { padding: 8px 10px; border-bottom: 1px solid #EEF1F5; vertical-align: top; }
  tr { cursor: pointer; }
  tr:hover { background: #F5F8FB; }
  tr.on { background: #E4EEF6; }
  .t { color: #5F6B7A; white-space: nowrap; }
  .mono { font-family: ui-monospace, monospace; font-weight: 500; white-space: nowrap; }
  .sub { color: #5F6B7A; font-size: 12.5px; }
  .chip { border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .chip.cito { background: #FDE8E8; color: #A3191B; }
  .chip.urgent { background: #FFF1DD; color: #864700; }
  .badge-cell { text-align: center; padding-left: 0; padding-right: 8px; }
  .badge { display: none; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: #1F6FB2; color: #fff; font-size: 12px; font-weight: 600; line-height: 22px; text-align: center; }
  .badge.on { display: inline-block; }
  .viewer { background: #0E141B; color: #E8EEF4; }
  .viewer h2 { color: #9AA7B4; border-color: #26313D; }
  .stage { flex: 1; display: grid; place-items: center; min-height: 0; padding: 8px; }
  canvas { max-width: 100%; max-height: 100%; aspect-ratio: 1; background: #000; }
  .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 12px; border-top: 1px solid #26313D; }
  .tools label { display: flex; align-items: center; gap: 6px; color: #9AA7B4; }
  .tools button { margin-left: auto; border: 0; border-radius: 10px; padding: 8px 14px; background: #1F6FB2; color: #fff; font-weight: 600; cursor: pointer; }
  #status { min-height: 20px; padding: 0 12px 10px; color: #B9C6D3; font-size: 12.5px; }
  #chat { flex: 1; min-height: 0; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } section { min-height: 420px; } }
</style>
</head>
<body>
<header><b>РИС</b><span>Рабочий список рентгенолога</span><span class="note">Песочница «Консилиума»: чат подключён через SDK встраивания</span></header>
<main>
  <section aria-label="Рабочий список"><h2>Исследования</h2><div class="list"><table>
    <colgroup><col class="c-time" /><col class="c-acc" /><col /><col class="c-prio" /><col class="c-badge" /></colgroup>
    <tbody id="worklist">${rows}</tbody></table></div></section>
  <section class="viewer" aria-label="Вьюер">
    <h2 id="viewer-title"></h2>
    <div class="stage"><canvas id="image" width="512" height="512"></canvas></div>
    <div class="tools">
      <label>Кадр <input id="frame" type="range" min="1" max="120" value="42" /> <span id="frame-n">42</span></label>
      <label>Окно <select id="window"><option value="1500/-600">Лёгкие</option><option value="400/40">Мягкие ткани</option><option value="700/100" selected>Сосуды</option></select></label>
      <button id="to-chat" type="button">В чат исследования</button>
    </div>
    <div id="status" role="status"></div>
  </section>
  <section aria-label="Чат исследования"><div id="chat"></div></section>
</main>
<script type="module">
  import { createChat } from ${json(`${chatUrl}/embed/v1/embed.js`)};
  const server = ${json(chatUrl)};
  const studies = ${json(studies.map((s) => ({ caseId: s.snapshot.case_id, title: s.snapshot.title, uid: s.snapshot.study_instance_uid ?? '1.2.643.0' })))};
  const $ = (id) => document.getElementById(id);
  let current = studies[0];

  function draw() {
    const frame = Number($('frame').value);
    const [ww, wc] = $('window').value.split('/').map(Number);
    $('frame-n').textContent = frame;
    $('viewer-title').textContent = current.caseId + ' · ' + current.title;
    const c = $('image').getContext('2d');
    const contrast = Math.min(1.6, 700 / ww);
    c.fillStyle = '#000'; c.fillRect(0, 0, 512, 512);
    const g = (v) => { const x = Math.max(0, Math.min(255, (v - 128) * contrast + 128 + (wc > 0 ? 10 : -10))); return 'rgb(' + x + ',' + x + ',' + x + ')'; };
    c.fillStyle = g(150); c.beginPath(); c.ellipse(256, 266, 200, 160, 0, 0, Math.PI * 2); c.fill();
    const lung = 70 + 25 * Math.sin(frame / 18);
    c.fillStyle = g(30);
    c.beginPath(); c.ellipse(176, 250, lung, 105, -0.15, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(336, 250, lung, 105, 0.15, 0, Math.PI * 2); c.fill();
    c.fillStyle = g(220); c.beginPath(); c.arc(256, 370, 26, 0, Math.PI * 2); c.fill();
    c.fillStyle = g(185); c.beginPath(); c.arc(256, 230, 30 + (frame % 7), 0, Math.PI * 2); c.fill();
    let seed = frame * 9301 + current.caseId.length;
    for (let i = 0; i < 1800; i++) { seed = (seed * 9301 + 49297) % 233280; const r = seed / 233280; c.fillStyle = 'rgba(255,255,255,' + (r * 0.06) + ')'; c.fillRect((r * 977) % 512, (r * 4513) % 512, 2, 2); }
    c.fillStyle = '#9AA7B4'; c.font = '13px ui-monospace, monospace';
    c.fillText(current.caseId + '  серия 3  кадр ' + frame, 12, 22); c.fillText('Ш/У ' + ww + '/' + wc, 12, 40);
  }

  const status = (t) => { $('status').textContent = t; };
  draw();
  $('frame').addEventListener('input', draw);
  $('window').addEventListener('change', draw);

  // 1. Панель чата исследования — контекст: открытое исследование.
  const chat = await createChat({ mode: 'panel', server, target: $('chat'), context: { connector: 'ris', caseId: current.caseId } });

  // 2. Счётчики непрочитанного для строк рабочего списка — отдельный невидимый фрейм.
  const counters = await createChat({ mode: 'headless', server });
  counters.watchUnread(studies.map((s) => ({ connector: 'ris', caseId: s.caseId })), (items) => {
    for (const row of document.querySelectorAll('#worklist tr')) {
      const item = items.find((i) => i.caseId.toUpperCase() === row.dataset.case.toUpperCase());
      const badge = row.querySelector('.badge');
      const n = item ? item.unread + (item.invited ? 1 : 0) : 0;
      badge.textContent = n ? String(n) : '';
      badge.classList.toggle('on', n > 0);
    }
  });

  // 3. Смена исследования в рабочем списке — смена контекста чата.
  function select(row) {
    document.querySelectorAll('#worklist tr').forEach((r) => r.classList.toggle('on', r === row));
    current = studies[Number(row.dataset.i)];
    draw();
    status('');
    chat.setContext({ connector: 'ris', caseId: current.caseId });
  }
  document.querySelectorAll('#worklist tr').forEach((row) => {
    row.addEventListener('click', () => select(row));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(row); });
  });

  // 4. «В чат исследования» — ключевой снимок с параметрами отображения и миниатюрой.
  $('to-chat').addEventListener('click', async () => {
    const frame = Number($('frame').value);
    const [ww, wc] = $('window').value.split('/').map(Number);
    try {
      await chat.attach({
        kind: 'key_image', studyUid: current.uid, seriesUid: current.uid + '.3', sopUid: current.uid + '.3.' + frame,
        frame, presentation: { ww, wc }, caption: 'Ключевой снимок: кадр ' + frame, thumbnail: $('image').toDataURL('image/png'),
      });
      status('Снимок отправлен в чат исследования');
    } catch (e) { status(e.message); }
  });

  // 5. Ссылка из чата — открыть тот же кадр в своём вьюере.
  chat.on('link.open', (link) => {
    if (link.kind === 'dicom') {
      $('frame').value = String(link.frame);
      if (link.presentation) $('window').value = link.presentation.ww + '/' + link.presentation.wc;
      draw();
      status('Открыт ключевой снимок из чата: кадр ' + link.frame);
    } else {
      window.open(link.url, '_blank', 'noopener');
    }
  });
</script>
</body>
</html>`;
}
