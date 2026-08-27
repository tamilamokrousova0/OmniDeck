# Знак «Триада» — как включить

Файлы в этой папке — готовые ассеты. Ничего из существующего не перезаписано.

## 1. Иконки сборки

```
cp assets/icon/brand-2026/icon.icns assets/icon/icon.icns
cp assets/icon/brand-2026/icon.ico  assets/icon/icon.ico
```

Пути в `package.json` (`mac.icon`, `win.icon`) менять не нужно.

## 2. Кнопка хаба — `src/renderer/index.html`, строки 14–28

Заменить весь `<svg class="brand-hub-svg">…</svg>` на:

```html
<svg class="brand-hub-svg" viewBox="0 0 48 48" width="34" height="34">
  <g class="brand-arcs" fill="none" stroke-width="5.2" stroke-linecap="round">
    <path class="brand-arc brand-arc-1" d="M19.61 38.34 A15 15 0 0 1 9.38 20.63" stroke="#3dd68c"/>
    <path class="brand-arc brand-arc-2" d="M13.77 13.03 A15 15 0 0 1 34.23 13.03" stroke="#5c9ff2"/>
    <path class="brand-arc brand-arc-3" d="M38.62 20.63 A15 15 0 0 1 28.39 38.34" stroke="#b18cf0"/>
  </g>
</svg>
```

## 3. Анимация — `src/renderer/styles.css`, строки 210–267

Весь блок `.brand-hub-svg … .brand.is-clicked .brand-link-5` заменить на:

```css
.brand-hub-svg { display: block; }

.brand-arcs {
  transform-origin: 50% 50%;
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.brand:hover .brand-arcs { transform: rotate(20deg); }
.brand.is-clicked .brand-arcs { transform: rotate(120deg); }

@media (prefers-reduced-motion: reduce) {
  .brand-arcs { transition: none; }
  .brand:hover .brand-arcs,
  .brand.is-clicked .brand-arcs { transform: none; }
}
```

Круг остаётся кругом, меняется только порядок цветов — вместо пульсации старого узла.
Классы `.brand-node`, `.brand-leaf`, `.brand-link`, `.brand-center`, `.brand-pulse` и
кадры `brandCenterIdle` после этого нигде не используются.

## На светлой теме

Если зелёный на белом покажется бледным, версии для светлого фона:
`#1f9e63` / `#2a72cf` / `#7c4fd6`.
