/* collect-recent.js — последние сообщения открытого чата для брифа звонка.
 *
 * Своей базы у OmniDeck нет, поэтому источник — DOM. Текст достаём готовым
 * экстрактором из bridge.js (window.__waDeckExtractMessageFromRow): он уже
 * переживает обфускацию классов mid-2026 и умеет отбрасывать мету.
 *
 * WhatsApp виртуализирует список: в DOM висит отрендеренное окно, а не вся
 * переписка. Берём сколько есть — если пользователь хочет глубже, он
 * прокручивает вверх и жмёт кнопку ещё раз. Сколько реально попало, вызывающий
 * показывает в шапке брифа.
 *
 * ponytail: определение направления продублировано из translator-bar.js
 * (там канонический isIncomingRow). Слить в общий хелпер в bridge.js, когда
 * фича перестанет быть тестовой — трогать рабочий переводчик ради теста
 * дороже, чем 10 строк дубля.
 */

function collectRecentScript(limit = 40) {
  return `(() => {
    const main = document.querySelector('#main');
    const mr = main ? main.getBoundingClientRect() : null;
    if (!mr || !mr.width) return [];
    let rtl = false;
    try { rtl = getComputedStyle(document.body).direction === 'rtl'; } catch {}

    const rows = Array.from(document.querySelectorAll('[role="row"]'))
      .filter((row) => row.querySelector('[data-pre-plain-text]'));

    const out = [];
    for (const row of rows.slice(-${Number(limit) || 40})) {
      const anchors = row.querySelectorAll('[data-pre-plain-text]');
      const bubble = anchors.length ? anchors[anchors.length - 1] : null;
      if (!bubble) continue;

      const text = window.__waDeckExtractMessageFromRow
        ? String(window.__waDeckExtractMessageFromRow(row) || '').trim()
        : '';
      if (!text) continue; // фото/голосовые без подписи — в бриф не идут

      const br = bubble.getBoundingClientRect();
      if (!br.width) continue;
      let incoming = (br.left - mr.left) < (mr.right - br.right);
      if (rtl) incoming = !incoming;

      // Префикс вида «[19:04, 12.08.2026] Имя: » — единственный источник даты
      const at = String(bubble.getAttribute('data-pre-plain-text') || '');
      out.push({ me: !incoming, text: text.slice(0, 600), at: at.slice(0, 40) });
    }
    return out;
  })();`;
}

export { collectRecentScript };
