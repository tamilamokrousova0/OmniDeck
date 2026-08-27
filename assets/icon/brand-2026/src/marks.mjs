// Знак «Триада»: буква O в OmniDeck собрана из трёх дуг — три канала, один круг.
// Бокс 48×48, центр 24,24, r=15, обводка 5.2, зазоры 34° (центры зазоров: 90°, 210°, 330°).
export const HUES = { green: '#3dd68c', blue: '#5c9ff2', violet: '#b18cf0' };
export const HUES_LIGHT = { green: '#1f9e63', blue: '#2a72cf', violet: '#7c4fd6' };

export const triad = (c = HUES, sw = 5.2) => `
  <g fill="none" stroke-width="${sw}" stroke-linecap="round">
    <path d="M19.61 38.34 A15 15 0 0 1 9.38 20.63" stroke="${c.green}"/>
    <path d="M13.77 13.03 A15 15 0 0 1 34.23 13.03" stroke="${c.blue}"/>
    <path d="M38.62 20.63 A15 15 0 0 1 28.39 38.34" stroke="${c.violet}"/>
  </g>`;

// Оптическая версия для 16px и меньше: толще обводка, шире зазоры (42°), r=14.5.
export const triadSm = (c = HUES, sw = 6.6) => `
  <g fill="none" stroke-width="${sw}" stroke-linecap="round">
    <path d="M18.80 37.54 A14.5 14.5 0 0 1 9.68 21.73" stroke="${c.green}"/>
    <path d="M14.88 12.73 A14.5 14.5 0 0 1 33.12 12.73" stroke="${c.blue}"/>
    <path d="M38.32 21.73 A14.5 14.5 0 0 1 29.20 37.54" stroke="${c.violet}"/>
  </g>`;

export const mono = (hex) => ({ green: hex, blue: hex, violet: hex });
export const svg = (body, size, extra = '') =>
  `<svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block" ${extra}>${body}</svg>`;
