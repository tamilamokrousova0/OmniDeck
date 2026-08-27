/* call-brief.js — кнопка «Бриф»: собрать последние сообщения открытого чата
   и отдать их локальной модели (main/call-brief.js) на короткое резюме перед
   звонком. Тестовая фича, только macOS. */

import { collectRecentScript } from './webview-scripts/collect-recent.js';
import { activeChatContactScript } from './webview-scripts/active-chat-contact.js';
import { closeModalAnimated } from './core/helpers.js';

  const LIMIT = 80; // два дня активной переписки в 40 строк не влезают

  let els, setStatus, activeAccount, selectedWebview;

  function init(ctx) {
    els = ctx.els;
    setStatus = ctx.setStatus;
    activeAccount = ctx.activeAccount;
    selectedWebview = ctx.selectedWebview;
  }

  function render(head, body) {
    if (!els.callBriefModal) return;
    if (els.callBriefHead) els.callBriefHead.textContent = head;
    if (els.callBriefText) els.callBriefText.textContent = body;
    els.callBriefModal.classList.remove('hidden');
  }

  function closeCallBrief() {
    closeModalAnimated(els.callBriefModal);
  }

  async function openCallBrief() {
    const account = activeAccount();
    const webview = selectedWebview();
    if (!account || !webview || account.frozen) {
      setStatus('Нет активного аккаунта');
      return;
    }

    let messages = [];
    let contactName = '';
    try {
      messages = await webview.executeJavaScript(collectRecentScript(LIMIT), true) || [];
      contactName = String(await webview.executeJavaScript(activeChatContactScript(), true) || '').trim();
    } catch (e) {
      console.warn('[call-brief] collect failed', e);
    }
    if (!messages.length) {
      setStatus('Откройте чат — в нём не видно сообщений');
      return;
    }

    /* Карточка контакта — тот же источник, что открывается кнопкой CRM.
       Нет карточки, не беда: бриф соберётся по одной переписке. */
    let crmAbout = '';
    let crmMine = '';
    if (contactName) {
      const card = await window.waDeck.crmLoadContact({
        accountId: account.id,
        accountName: account.name,
        contactName,
      }).catch(() => null);
      if (card?.ok) {
        crmAbout = String(card.record?.about || '').trim();
        crmMine = String(card.record?.myInfo || '').trim();
      }
    }

    /* Разбивка «своих/чужих» видна в шапке намеренно: сразу понятно, что в
       бриф ушли обе стороны переписки, а не только входящие. */
    const mine = messages.filter((m) => m.me).length;
    const head = `Бриф по ${messages.length} сообщениям (${mine} моих)`;

    // Про скачивание модели пишем только когда она реально качается — это
    // приходит событием прогресса ниже. Здесь просто ждём загрузки.
    render(`${head}…`, 'Модель загружается, около 15 секунд.');

    /* Прогресс приходит событиями из main: скачивание модели идёт минутами,
       и без цифр окно выглядит зависшим. */
    const offProgress = window.waDeck.onCallBriefProgress((info) => {
      if (info.stage === 'download') {
        render('Качаю модель…', `${info.mb} МБ из ~2300 МБ. Один раз, дальше бриф собирается за ~15 секунд.`);
      } else if (info.stage === 'thinking') {
        render(`${head}…`, 'Модель читает переписку.');
      }
    });

    const res = await window.waDeck.callBrief({ messages, contactName, crmAbout, crmMine })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }))
      .finally(() => { try { offProgress(); } catch { /* ignore */ } });
    if (!res?.ok) {
      render('Бриф не собрался', res?.error || 'unknown_error');
      return;
    }
    render(head, res.text);
  }

  export const WaDeckCallBriefModule = { init, openCallBrief, closeCallBrief };
  window.WaDeckCallBriefModule = WaDeckCallBriefModule;
