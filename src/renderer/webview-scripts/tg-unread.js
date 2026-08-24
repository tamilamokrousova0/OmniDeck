/**
 * Счётчик непрочитанных для Telegram Web A (web.telegram.org/a).
 *
 * DOM-классы бейджей у telegram-tt — хешированные CSS-модули (меняются каждый
 * билд), по ним строить нельзя (тот же урок, что и с WhatsApp mid-2026).
 * Вместо DOM перехватываем API-контракт: telegram-tt сам зовёт
 * navigator.setAppBadge(count) при каждом изменении общего счётчика
 * (UnreadCounter → updateAppBadge, count = непрочитанные НЕзамьюченные чаты
 * по всем папкам — ровно то число, что Telegram вешает на свой бейдж).
 *
 * Перехватчик ПОДМЕНЯЕТ setAppBadge и не зовёт оригинал: в Electron Badging
 * API транслируется в бейдж приложения и задваивал бы наш собственный
 * док-бейдж, который renderer агрегирует по всем аккаунтам сам.
 */
function tgBadgeInterceptScript() {
  return `(() => {
    if (window.__waDeckTgBadgeBound) return true;
    window.__waDeckTgBadgeBound = true;
    try {
      Object.defineProperty(navigator, 'setAppBadge', {
        configurable: true,
        writable: true,
        value: (count) => {
          const n = Number(count);
          window.__waDeckTgUnread = Number.isFinite(n) && n >= 0 ? n : 0;
          return Promise.resolve();
        },
      });
      Object.defineProperty(navigator, 'clearAppBadge', {
        configurable: true,
        writable: true,
        value: () => {
          window.__waDeckTgUnread = 0;
          return Promise.resolve();
        },
      });
    } catch (e) { /* non-fatal: остаёмся без счётчика, хост держит прежнее значение */ }
    return true;
  })();`;
}

/* -1 = «не смог посчитать» — хост сохраняет прежнее значение (контракт тот же,
 * что у collectUnreadCountScript для WhatsApp). Значение появляется после
 * первого вызова setAppBadge со стороны telegram-tt (эффект на маунте
 * UnreadCounter), т.е. вскоре после загрузки залогиненного приложения. */
function collectTgUnreadCountScript() {
  return `(() => {
    const v = window.__waDeckTgUnread;
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : -1;
  })();`;
}

export { tgBadgeInterceptScript, collectTgUnreadCountScript };
