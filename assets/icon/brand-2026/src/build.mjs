import { writeFileSync } from 'node:fs';
import { triad, triadSm, mono, svg, HUES, HUES_LIGHT } from './marks.mjs';

const CSS = `
  body { margin:0; font-family:'Inter',-apple-system,'Segoe UI',sans-serif; background:#101520;
         color:#e5eaf0; -webkit-font-smoothing:antialiased; }
  a { color:#3dd68c; } a:hover { color:#2db36e; }
  .board { display:flex; flex-direction:column; gap:30px; padding:40px 38px 38px; }
  .eyebrow { font:500 11px/1 ui-monospace,'SF Mono',Menlo,monospace; letter-spacing:0.16em;
             text-transform:uppercase; color:#6b7a90; }
  .h1 { font-size:40px; font-weight:600; letter-spacing:-0.03em; margin:11px 0 7px; }
  .tag { font-size:14px; line-height:1.5; color:#95a0b4; max-width:52ch; }
  .cap { font:500 10px/1.4 ui-monospace,'SF Mono',Menlo,monospace; letter-spacing:0.1em;
         text-transform:uppercase; color:#58657a; }
  .rule { height:1px; background:#242b38; }
  .row { display:flex; gap:26px; align-items:flex-end; flex-wrap:wrap; }
  .stack { display:flex; flex-direction:column; gap:10px; }
  .tile { display:flex; align-items:center; justify-content:center; flex:0 0 auto;
          box-shadow:0 12px 34px -16px rgba(0,0,0,.75); }
  .lock { display:flex; align-items:center; gap:2px; }
  .word { font-weight:600; letter-spacing:-0.03em; margin-left:-1px; }
  .chip { display:flex; align-items:center; justify-content:center; border-radius:9px;
          border:1px solid #242b38; width:46px; height:46px; }
  .side { width:60px; border:1px solid #2b313b; border-radius:12px;
          background:linear-gradient(180deg,#1a2030 0%,#151a24 100%);
          display:flex; flex-direction:column; align-items:center; gap:10px; padding:10px 8px; }
  .side.lt { border-color:#cad8ed; background:linear-gradient(180deg,#eaf2ff 0%,#f1f6ff 100%); }
  .brandbtn { width:40px; height:40px; border-radius:12px; border:1px solid #2b313b;
              background:linear-gradient(180deg,#1a2030 0%,#181e2b 100%);
              display:flex; align-items:center; justify-content:center; }
  .brandbtn.lt { border-color:#cad8ed; background:linear-gradient(180deg,#ffffff 0%,#f6faff 100%); }
  .acct { width:34px; height:34px; border-radius:9px; background:#232a38; }
  .acct.lt { background:#dbe6f7; }
  .acct.on { box-shadow:inset 0 0 0 1.5px #3dd68c; }
  .note { display:grid; grid-template-columns:96px 1fr; gap:14px; align-items:baseline; }
  .note b { font:500 10px/1.6 ui-monospace,'SF Mono',Menlo,monospace; letter-spacing:0.1em;
            text-transform:uppercase; color:#58657a; }
  .note span { font-size:13px; line-height:1.55; color:#b8c2d0; }
  .sw { display:flex; align-items:center; gap:11px; }
  .dot { width:22px; height:22px; border-radius:7px; }
  .sw code { font:12px ui-monospace,'SF Mono',Menlo,monospace; color:#e5eaf0; }
  .sw em { font-style:normal; font-size:12px; color:#7d8798; }`;

const shell = (body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
  <style>${CSS}</style>
</helmet>
${body}
</x-dc>
</body>
</html>
`;

const R = (s) => Math.round(s * 0.2245); // радиус скругления плитки как в macOS-иконке (185/824)
const tile = (size, bg, colors, brd = '') =>
  `<div class="tile" style="width:${size}px;height:${size}px;border-radius:${R(size)}px;background:${bg};${brd}">${svg(triad(colors), Math.round(size * 0.6))}</div>`;
const lock = (size, colors) =>
  `<div class="lock">${svg(triad(colors), size * 1.14)}<div class="word" style="font-size:${size}px">mniDeck</div></div>`;

// ── Артборд 1: знак ───────────────────────────────────────────────────────
const main = shell(`<div class="board">
  <div>
    <div class="eyebrow">Знак · утверждено</div>
    <div class="h1">Триада</div>
    <div class="tag">Буква «O» в OmniDeck собрана из трёх дуг: три канала — WhatsApp, Telegram, Signal — замыкаются в один круг. Иконка и логотип — одна и та же форма, поэтому согласовывать между собой нечего.</div>
  </div>

  <div class="row">
    <div class="stack">${lock(46, HUES)}<div class="cap">Логотип · тёмный фон</div></div>
    <div class="stack" style="background:#ffffff;padding:14px 18px;border-radius:12px">
      <div class="lock">${svg(triad(HUES_LIGHT), 34)}<div class="word" style="font-size:30px;color:#11233a">mniDeck</div></div>
      <div class="cap" style="color:#8496ad">Светлый фон</div>
    </div>
  </div>

  <div class="rule"></div>

  <div class="row">
    <div class="stack">${tile(196, '#12161d', HUES)}<div class="cap">Иконка приложения · 1024</div></div>
    <div class="stack">${tile(112, '#ffffff', HUES_LIGHT, 'box-shadow:0 12px 34px -18px rgba(20,40,70,.5)')}<div class="cap">Светлая плитка</div></div>
    <div class="stack">
      <div class="side"><div class="brandbtn">${svg(triad(HUES), 34)}</div><div class="acct on"></div><div class="acct"></div><div class="acct"></div></div>
      <div class="cap">Хаб · 34 в кнопке 40</div>
    </div>
    <div class="stack">
      <div class="side lt"><div class="brandbtn lt">${svg(triad(HUES_LIGHT), 34)}</div><div class="acct lt on"></div><div class="acct lt"></div><div class="acct lt"></div></div>
      <div class="cap">Светлая тема</div>
    </div>
  </div>

  <div class="rule"></div>

  <div class="stack">
    <div class="cap">Размеры · обычное начертание</div>
    <div class="row" style="gap:10px;align-items:flex-end">
      ${[32, 24, 16].map((s) => `<div class="stack" style="gap:7px"><div class="chip" style="background:#151a24">${svg(triad(HUES), s)}</div><div class="cap" style="text-align:center">${s}</div></div>`).join('')}
      <div style="width:16px"></div>
      ${[32, 24, 16].map((s) => `<div class="stack" style="gap:7px"><div class="chip" style="background:#fff;border-color:#d7dfea">${svg(triad(HUES_LIGHT), s)}</div><div class="cap" style="text-align:center">${s}</div></div>`).join('')}
      <div style="width:16px"></div>
      ${[24, 16].map((s) => `<div class="stack" style="gap:7px"><div class="chip" style="background:#151a24">${svg(triad(mono('#e5eaf0')), s)}</div><div class="cap" style="text-align:center">моно ${s}</div></div>`).join('')}
    </div>
  </div>

  <div class="stack">
    <div class="cap">Размеры · 16 и мельче, оптическая правка</div>
    <div class="row" style="gap:10px;align-items:flex-end">
      ${[16, 14].map((s) => `<div class="stack" style="gap:7px"><div class="chip" style="background:#151a24">${svg(triadSm(HUES), s)}</div><div class="cap" style="text-align:center">${s}</div></div>`).join('')}
      ${[16, 14].map((s) => `<div class="stack" style="gap:7px"><div class="chip" style="background:#151a24">${svg(triadSm(mono('#e5eaf0')), s)}</div><div class="cap" style="text-align:center">моно ${s}</div></div>`).join('')}
      <div class="tag" style="max-width:30ch;margin-left:8px">Обводка 6.6 вместо 5.2, зазоры 42° вместо 34°, радиус 14.5. Без этой правки на 16px зазоры замыливаются в сплошное кольцо.</div>
    </div>
  </div>

  <div class="rule"></div>

  <div class="row" style="align-items:flex-start;gap:36px">
    <div class="stack">
      <div style="width:170px;height:170px;border-radius:14px;background:#151a24;display:flex;align-items:center;justify-content:center;position:relative">
        ${svg(`<circle cx="24" cy="24" r="15" fill="none" stroke="#3a4557" stroke-width="0.6" stroke-dasharray="1.6 1.6"/>
               <line x1="24" y1="24" x2="24" y2="9" stroke="#3a4557" stroke-width="0.6"/>
               <circle cx="24" cy="24" r="0.9" fill="#3a4557"/>` + triad(HUES), 138)}
      </div>
      <div class="cap">Построение</div>
    </div>
    <div class="stack" style="gap:14px">
      <div class="note"><b>Геометрия</b><span>Сетка 48×48, окружность r=15, обводка 5.2 со скруглёнными концами. Три дуги по 86°, зазоры 34° с центрами на 90°, 210° и 330°.</span></div>
      <div class="note"><b>Цвета</b><span style="display:flex;flex-direction:column;gap:9px">
        <span class="sw"><span class="dot" style="background:${HUES.green}"></span><code>${HUES.green}</code><em>--accent · зелёный интерфейса</em></span>
        <span class="sw"><span class="dot" style="background:${HUES.blue}"></span><code>${HUES.blue}</code><em>--accent-blue</em></span>
        <span class="sw"><span class="dot" style="background:${HUES.violet}"></span><code>${HUES.violet}</code><em>--accent-violet</em></span>
        <span class="sw"><span class="dot" style="background:${HUES_LIGHT.green};box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)"></span><code>${HUES_LIGHT.green} ${HUES_LIGHT.blue} ${HUES_LIGHT.violet}</code><em>на светлом фоне</em></span>
      </span></div>
      <div class="note"><b>Плитка</b><span>Фон #12161d, скругление 22,45% от стороны (185/824 — как в текущей иконке). Ни градиентов, ни свечения: знак держится формой, а не эффектами.</span></div>
    </div>
  </div>
</div>`);
writeFileSync('Main.dc.html', main);

// ── Артборд 2: в контексте ────────────────────────────────────────────────
const dockOther = (c) => `<div style="width:52px;height:52px;border-radius:${R(52)}px;background:${c}"></div>`;
const usage = shell(`<div class="board">
  <div>
    <div class="eyebrow">Применение</div>
    <div class="h1">В контексте</div>
    <div class="tag">Как знак ведёт себя там, где его реально видят: среди чужих иконок, в мелком моно и в собственном интерфейсе.</div>
  </div>

  <div class="stack">
    <div class="cap">macOS · Dock</div>
    <div style="display:flex;gap:11px;align-items:center;padding:11px 15px;border-radius:19px;
                background:rgba(150,170,200,0.14);border:1px solid rgba(255,255,255,0.09);width:max-content">
      ${dockOther('#3b4a5e')}${dockOther('#4a3f5e')}
      <div class="tile" style="width:60px;height:60px;border-radius:${R(60)}px;background:#12161d">${svg(triad(HUES), 36)}</div>
      ${dockOther('#2f4a44')}${dockOther('#54423a')}
    </div>
  </div>

  <div class="stack">
    <div class="cap">Windows · панель задач</div>
    <div style="display:flex;gap:20px;align-items:center;padding:8px 18px;background:#1b1f26;
                border-top:1px solid #2b313b;width:max-content;border-radius:6px">
      <div style="width:22px;height:22px;border-radius:4px;background:#3b4a5e"></div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:5px">
        ${svg(triad(HUES), 24)}
        <div style="width:20px;height:2px;border-radius:1px;background:${HUES.green}"></div>
      </div>
      <div style="width:22px;height:22px;border-radius:4px;background:#4a3f5e"></div>
    </div>
  </div>

  <div class="stack">
    <div class="cap">Менюбар · моно 18</div>
    <div style="display:flex;gap:16px;align-items:center;padding:6px 16px;background:#22262e;
                border-radius:7px;width:max-content">
      ${svg(triadSm(mono('#e5eaf0')), 18)}
      <span style="font-size:12px;color:#95a0b4">4 непрочитанных</span>
    </div>
  </div>

  <div class="rule"></div>

  <div class="stack">
    <div class="cap">Кнопка хаба · состояния</div>
    <div class="row" style="gap:22px">
      <div class="stack" style="gap:8px"><div class="brandbtn">${svg(triad(HUES), 34)}</div><div class="cap" style="text-align:center">покой</div></div>
      <div class="stack" style="gap:8px"><div class="brandbtn" style="transform:scale(1.08);border-color:#3a4557">${svg(triad(HUES), 34)}</div><div class="cap" style="text-align:center">наведение</div></div>
      <div class="stack" style="gap:8px"><div class="brandbtn" style="border-color:${HUES.green};box-shadow:0 0 0 2px rgba(61,214,140,.22)">${svg(triad(HUES), 34)}</div><div class="cap" style="text-align:center">хаб открыт</div></div>
      <div class="stack" style="gap:8px"><div class="brandbtn" style="position:relative">${svg(triad(HUES), 34)}<span style="position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;border-radius:8px;background:#d94040;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 4px;border:2px solid #151a24">4</span></div><div class="cap" style="text-align:center">непрочитанные</div></div>
    </div>
  </div>

  <div class="note" style="grid-template-columns:96px 1fr">
    <b>Анимация</b><span>Вместо пульсации старого узла — дуги проворачиваются на 120° за 400 мс при открытии хаба: круг остаётся кругом, меняется только порядок цветов.</span>
  </div>
</div>`);
writeFileSync('Usage.dc.html', usage);

writeFileSync('canvas.json', JSON.stringify({
  artboards: [
    { file: 'Main.dc.html', x: 0, y: 0, w: 880, h: 1080 },
    { file: 'Usage.dc.html', x: 980, y: 0, w: 660, h: 800 },
  ],
  launch: { view: 'canvas' },
}, null, 2));

// ── Продакшн-ассеты ───────────────────────────────────────────────────────
const icon1024 = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#12161d"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#ffffff" stroke-opacity="0.06"/>
  <g transform="translate(512 512) scale(17) translate(-24 -24)">${triad(HUES)}
  </g>
</svg>
`;
writeFileSync('omnideck-icon-1024.svg', icon1024);
// Та же плитка, но с оптической правкой знака — источник для растров 32px и мельче.
writeFileSync('omnideck-icon-small.svg', icon1024.replace(triad(HUES), triadSm(HUES)));
writeFileSync('brand-hub.svg.html', `<svg class="brand-hub-svg" viewBox="0 0 48 48" width="34" height="34">${triad(HUES)}
          </svg>
`);
console.log('ok');
