/**
 * Демо-страница «ЛИС» песочницы: форма случая патоморфологии с плавающим чатом (режим launcher SDK «Консилиума»)
 * и кнопкой «В чат» у стекла — так ЛИС отправляет препарат в чат случая. Макет — «ЛИС — форма случая с плавающим
 * чатом». Это пример для команды ЛИС; все данные вымышлены.
 */
import type { CaseSnapshot } from '@konsilium/protocol/integration';

interface Slide {
  n: string;
  block: string;
  stain: string;
  scanned: boolean;
}

interface CaseExtra {
  direction: string;
  department: string;
  material: string;
  stages: Array<{ name: string; at: string; now?: boolean }>;
  microscopy: string;
  slides: Slide[];
  conclusion: string;
}

/** Содержимое формы, которого нет в снимке случая (в настоящей ЛИС оно своё). */
const EXTRA: Record<string, CaseExtra> = {
  'Г26-04512': {
    direction: '№ Н-2611 от 06.10 · Колесников Д. А.',
    department: 'Онкологическое № 2',
    material: 'Core-биопсия, 3 столбика, блоки 1А–1В',
    stages: [
      { name: 'Регистрация', at: '06.10, 08:40' },
      { name: 'Вырезка', at: '06.10, 08:55' },
      { name: 'Проводка, окраска H&E, скан', at: '06.10, 09:50' },
      { name: 'Микроскопия', at: 'сейчас', now: true },
      { name: 'ИГХ', at: 'к 07.10, 11:00' },
      { name: 'Заключение и подпись УКЭП', at: '—' },
    ],
    microscopy:
      'В столбиках ткани молочной железы — инфильтративный рост карциномы неспецифического типа: солидные и трабекулярные структуры, местами железистоподобные. Ядерный полиморфизм умеренный, митозы — до 8 в 10 полях зрения большого увеличения. В блоке 1Б — фокус протоковой карциномы in situ высокой ядерной степени с комедонекрозом, около 10% площади.',
    slides: [
      { n: '1', block: '1А', stain: 'H&E', scanned: true },
      { n: '2', block: '1Б', stain: 'H&E', scanned: true },
      { n: '3', block: '1В', stain: 'H&E', scanned: true },
      { n: '4', block: '1А', stain: 'ER', scanned: false },
      { n: '5', block: '1А', stain: 'PR', scanned: false },
      { n: '6', block: '1А', stain: 'HER2', scanned: false },
      { n: '7', block: '1А', stain: 'Ki-67', scanned: false },
      { n: '8', block: '1Б', stain: 'H&E, дорезка', scanned: true },
      { n: '9', block: '1Б', stain: 'CK5/6', scanned: true },
    ],
    conclusion:
      'Инвазивная карцинома молочной железы неспецифического типа, G2 (Ноттингемская система: 2 + 2 + 2 = 6 баллов). Компонент DCIS высокой ядерной степени. Окончательное заключение — после ИГХ-исследования.',
  },
};

const DEFAULT_EXTRA: CaseExtra = {
  direction: '№ Н-2640 от 07.10',
  department: 'Хирургическое № 1',
  material: 'Операционный материал, 1 фрагмент',
  stages: [
    { name: 'Регистрация', at: '07.10, 10:20' },
    { name: 'Вырезка', at: 'сейчас', now: true },
    { name: 'Проводка, окраска H&E, скан', at: '—' },
    { name: 'Микроскопия', at: '—' },
    { name: 'Заключение и подпись УКЭП', at: '—' },
  ],
  microscopy: '',
  slides: [
    { n: '1', block: '1', stain: 'H&E', scanned: true },
    { n: '2', block: '2', stain: 'H&E', scanned: false },
  ],
  conclusion: '',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function renderLisDemo(chatUrl: string, cases: CaseSnapshot[], selected?: string): string {
  const current = cases.find((c) => c.case_id.toUpperCase() === selected?.toUpperCase()) ?? cases[0]!;
  const x = EXTRA[current.case_id] ?? DEFAULT_EXTRA;
  const due = current.due ? new Date(current.due).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : null;
  const prio = current.priority === 'cito' ? 'CITO' : current.priority === 'urgent' ? 'Срочно' : '';
  const scanned = x.slides.filter((s) => s.scanned).length;
  const patient = [current.patient.masked, current.patient.age !== undefined ? `${current.patient.age} г.` : null].filter(Boolean).join(', ');

  const options = cases.map((c) => `<option value="${esc(c.case_id)}"${c === current ? ' selected' : ''}>${esc(c.case_id)} · ${esc(c.title)}</option>`).join('');
  const stages = x.stages
    .map((s) => `<li class="${s.now ? 'now' : s.at === '—' ? 'todo' : 'done'}"><span>${esc(s.name)}</span><span class="at">${esc(s.at)}</span></li>`)
    .join('');
  const slides = x.slides
    .map(
      (s) => `<tr data-slide="${esc(s.n)}">
        <td class="mono">${esc(s.n)}</td><td class="mono">${esc(s.block)}</td><td>${esc(s.stain)}</td>
        <td class="${s.scanned ? 'ok' : 'wait'}">${s.scanned ? 'Отсканировано' : 'Ожидает окраски'}</td>
        <td class="act">${s.scanned ? `<button type="button" class="to-chat" data-slide="${esc(s.n)}" aria-label="Стекло ${esc(s.n)} в чат">В чат</button>` : ''}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ЛИС · случай ${esc(current.case_id)} (песочница)</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #16202B; background: #F3F5F8; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; min-height: 56px; padding: 6px 20px; background: #fff; border-bottom: 1px solid #E1E7ED; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 600; }
  .logo b { width: 32px; height: 32px; border-radius: 9px; background: #1F6FB2; color: #fff; display: grid; place-items: center; font-size: 11px; }
  nav { display: flex; gap: 4px; }
  nav a { padding: 6px 12px; border-radius: 8px; color: #2B3846; text-decoration: none; }
  nav a[aria-current] { background: #E4EEF6; color: #14476F; font-weight: 600; }
  header label { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #4E5A68; font-size: 13px; }
  header select { font: inherit; padding: 5px 8px; border-radius: 8px; border: 1px solid #D5DDE5; background: #fff; max-width: 340px; }
  .note { width: 100%; font-size: 12.5px; color: #5F6B7A; }
  .page { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px 20px 120px; }
  .card { background: #fff; border: 1px solid #E1E7ED; border-radius: 14px; padding: 18px; }
  aside.card { flex: 1 1 300px; max-width: 380px; display: grid; gap: 14px; }
  main { flex: 3 1 560px; min-width: 0; display: grid; gap: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .id { font-family: ui-monospace, monospace; font-size: 19px; font-weight: 600; }
  .sub { color: #4E5A68; }
  .chip { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #EEF1F5; color: #2B3846; }
  .chip.urgent { background: #FDE8E8; color: #A3191B; }
  dl { margin: 0; display: grid; gap: 8px; }
  dt { font-size: 12.5px; color: #5F6B7A; } dd { margin: 0; }
  ol.stages { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  ol.stages li { display: flex; justify-content: space-between; gap: 8px; padding-left: 14px; position: relative; }
  ol.stages li::before { content: ''; position: absolute; left: 0; top: 7px; width: 7px; height: 7px; border-radius: 50%; background: #2E7D32; }
  ol.stages li.now::before { background: #1F6FB2; box-shadow: 0 0 0 3px #D4E5F4; }
  ol.stages li.todo::before { background: #C3CCD6; }
  ol.stages li.now { font-weight: 600; }
  .at { color: #5F6B7A; font-size: 12.5px; white-space: nowrap; }
  textarea { width: 100%; resize: vertical; padding: 12px 14px; border-radius: 10px; border: 1px solid #D5DDE5; background: #FBFCFD; font: inherit; line-height: 1.5; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12.5px; color: #4E5A68; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid #E1E7ED; }
  td { padding: 6px 10px; border-bottom: 1px solid #EEF2F6; height: 46px; }
  tr.on { background: #FFF7E0; }
  .mono { font-family: ui-monospace, monospace; }
  td.ok { color: #1B6B2E; } td.wait { color: #864700; }
  td.act { text-align: right; }
  .to-chat { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid #D5DDE5; background: #fff; color: #14476F; font: inherit; font-weight: 600; cursor: pointer; }
  .to-chat:hover { background: #F2F7FB; }
  #status { min-height: 20px; color: #14476F; font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
  .actions button { height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #D5DDE5; background: #fff; font: inherit; font-weight: 600; }
  .actions .sign { border: 0; background: #1F6FB2; color: #fff; opacity: .55; }
  .hint { font-size: 12.5px; color: #864700; }
</style>
</head>
<body>
<header>
  <span class="logo"><b>ЛИС</b>Патоморфология</span>
  <nav aria-label="Разделы ЛИС"><a href="#" aria-current="page">Случаи</a><a href="#">Вырезка</a><a href="#">Микроскопия</a><a href="#">ИГХ</a><a href="#">Архив</a></nav>
  <label>Случай <select id="case" aria-label="Случай">${options}</select></label>
  <span class="note">Песочница «Консилиума»: чат случая — плавающая кнопка внизу справа (SDK встраивания, режим launcher)</span>
</header>
<div class="page">
  <aside class="card" aria-label="Карточка случая ЛИС">
    <div><div class="id">${esc(current.case_id)}</div><div class="sub">${esc(current.title)}</div></div>
    <div>${prio ? `<span class="chip ${current.priority}">${prio}${due ? ` · до ${esc(due)}` : ''}</span>` : due ? `<span class="chip">до ${esc(due)}</span>` : ''}</div>
    <dl>
      <div><dt>Пациент</dt><dd>${esc(patient)}</dd></div>
      <div><dt>Направление</dt><dd>${esc(x.direction)}</dd></div>
      <div><dt>Отделение</dt><dd>${esc(x.department)}</dd></div>
      <div><dt>Материал</dt><dd>${esc(x.material)}</dd></div>
    </dl>
    <div><h2>Этапы</h2><ol class="stages">${stages}</ol></div>
  </aside>
  <main>
    <section class="card" aria-labelledby="micro-h">
      <div class="head"><h2 id="micro-h">Микроскопическое описание</h2><span class="sub">Шаблон: РМЖ, биопсия · v3</span></div>
      <textarea rows="5" aria-labelledby="micro-h">${esc(x.microscopy)}</textarea>
    </section>
    <section class="card" aria-labelledby="slides-h">
      <div class="head"><h2 id="slides-h">Стёкла</h2><span class="sub">${x.slides.length} стёкол · ${scanned} отсканировано</span></div>
      <div id="status" role="status"></div>
      <table><thead><tr><th>Стекло</th><th>Блок</th><th>Окраска</th><th>Скан</th><th></th></tr></thead><tbody>${slides}</tbody></table>
    </section>
    <section class="card" aria-labelledby="concl-h">
      <h2 id="concl-h">Заключение · черновик</h2>
      <textarea rows="3" aria-labelledby="concl-h" style="margin-top:8px">${esc(x.conclusion)}</textarea>
      <div class="actions"><button type="button">Сохранить черновик</button><button type="button" class="sign" disabled>Подписать УКЭП</button><span class="hint">Подпись станет доступна после ИГХ</span></div>
    </section>
  </main>
</div>
<script type="module">
  import { createChat } from ${json(`${chatUrl}/embed/v1/embed.js`)};
  const server = ${json(chatUrl)};
  const caseId = ${json(current.case_id)};
  const slides = ${json(x.slides)};
  const $ = (id) => document.getElementById(id);
  const status = (t) => { $('status').textContent = t; };

  $('case').addEventListener('change', (e) => { location.search = '?case=' + encodeURIComponent(e.target.value); });

  // 1. Плавающий чат случая: кнопка внизу справа, окно поверх формы, бейдж непрочитанного на кнопке.
  const chat = await createChat({ mode: 'launcher', server, title: 'Чат случая', context: { connector: 'lis', caseId }, launcher: { label: 'Чат случая' } });

  // Миниатюра области стекла — в настоящей ЛИС её даёт вьюер цифровой патологии (DICOM WSI).
  function thumbnail(slide) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const ihc = !/H&E/.test(slide.stain);
    g.fillStyle = ihc ? '#E9EEF6' : '#F6D7E4'; g.fillRect(0, 0, 256, 256);
    let seed = Number(slide.n) * 7919 + slide.block.length;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    g.fillStyle = ihc ? '#D7DDEA' : '#E8A9C8';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.ellipse(rnd() * 256, rnd() * 256, 40 + rnd() * 60, 18 + rnd() * 30, rnd() * 3, 0, Math.PI * 2); g.fill(); }
    for (let i = 0; i < 420; i++) {
      g.fillStyle = ihc ? (rnd() < 0.35 ? '#7A4A1E' : '#5B6FA8') : (rnd() < 0.5 ? '#4B2779' : '#5E3591');
      g.beginPath(); g.ellipse(rnd() * 256, rnd() * 256, 2.5 + rnd() * 2, 2 + rnd() * 1.5, rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    return c.toDataURL('image/png');
  }

  // 2. «В чат» у стекла: препарат (область скана, окраска, увеличение, миниатюра) уходит в чат случая.
  for (const button of document.querySelectorAll('.to-chat')) {
    button.addEventListener('click', async () => {
      const slide = slides.find((s) => s.n === button.dataset.slide);
      try {
        await chat.attach({
          kind: 'slide_roi', slideId: slide.n, block: slide.block, stain: slide.stain, magnification: 20,
          region: { x: 12800 + Number(slide.n) * 512, y: 8400, w: 2048, h: 2048, level: 0 }, thumbnail: thumbnail(slide),
        });
        status('Стекло ' + slide.n + ' отправлено в чат случая');
        await chat.open();
      } catch (e) { status(e.message); }
    });
  }

  // 3. «Открыть во вьюере» в чате — ЛИС открывает стекло в своём окне цифровой патологии.
  chat.on('link.open', (link) => {
    if (link.kind === 'slide') {
      document.querySelectorAll('tr[data-slide]').forEach((r) => r.classList.toggle('on', r.dataset.slide === link.slideId));
      status('Открыто стекло ' + link.slideId + ' (' + link.stain + ', ×' + link.magnification + ', область ' + link.region.x + ',' + link.region.y + ') — во вьюере ЛИС');
    } else if ('url' in link) {
      window.open(link.url, '_blank', 'noopener');
    }
  });
</script>
</body>
</html>`;
}
