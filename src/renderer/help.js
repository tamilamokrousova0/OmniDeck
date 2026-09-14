/* F1 — справка: все основные функции дека на одном экране.
   Оверлей строится лениво при первом открытии; F1 — открыть/закрыть,
   Esc / ✕ / клик мимо — закрыть. Контент статический — обновляется вместе
   с фичами в этом файле. */

  const SECTIONS = [
    {
      title: 'Аккаунты и дек',
      items: [
        ['Плитки слева', 'добавление WhatsApp/Telegram/Signal, перетаскивание, закрепление, заморозка. Клик по логотипу — стартовый хаб.'],
        ['Хаб', 'дашборд аккаунтов с вкладками: Аккаунты, Непрочитанные, Избранные, Важные. Непрочитанные — все новые сообщения по всем аккаунтам одним списком, клик открывает чат.'],
        ['Гибернация', 'в настройках: спящие аккаунты выгружаются из памяти и просыпаются по клику.'],
      ],
    },
    {
      title: 'Глобальный поиск — Cmd/Ctrl+K',
      items: [
        ['По имени', 'ищет по всем аккаунтам сразу: избранные, важные и все чаты (списки собираются в фоне и переживают перезапуск).'],
        ['По номеру', 'цифры сравниваются без «+», пробелов и дефисов; запрос-номер даёт действие «открыть по номеру» в каждом аккаунте — WhatsApp найдёт чат, даже если его нет в списках.'],
      ],
    },
    {
      title: 'Переводчик (панель над полем ввода)',
      items: [
        ['Входящие', 'тумблер «Авто вх.» переводит новые сообщения на русский поверх пузырей.'],
        ['Выделенный текст', 'кнопка «Перевести» переводит выделенное в поле ввода на язык клиента (язык запоминается за контактом).'],
      ],
    },
    {
      title: 'Шаблоны',
      items: [
        ['Слэш-команда — новое', 'наберите «/» первым символом в поле ввода WhatsApp — появится список шаблонов с фильтром по мере набора: ↑↓ выбор, Enter вставить, Esc закрыть.'],
        ['Панель шаблонов', 'Cmd/Ctrl+T или кнопка в тулбаре — раздел настроек с библиотекой: создание и правка шаблонов.'],
        ['Переменные', '{имя}, {приветствие}, {дата}, {время} подставляются при вставке.'],
      ],
    },
    {
      title: 'Отложенные сообщения',
      items: [
        ['Планировщик', 'кнопка с часами в тулбаре — раздел настроек: текст, вложения, дата и время, быстрые кнопки времени, очередь заданий.'],
        ['Повторы', 'каждый день / по будням / раз в неделю, джиттер ±5/15/30 минут, чтобы серии не уходили в одну минуту.'],
        ['Надёжность', 'временные сбои (webview грузится) — до 3 повторных попыток.'],
      ],
    },
    {
      title: 'Избранные ★ и Важные ⚑',
      items: [
        ['Метки', 'через контекстное меню чата в списке WhatsApp.'],
        ['Приоритетная лента', 'полоса под тулбаром: контакты с новыми сообщениями, клик — мгновенный переход (счётчик сбрасывается сразу).'],
        ['Уведомления', 'WhatsApp — о сообщениях избранных и важных контактов; Telegram и Signal — о любом входящем. Клик открывает нужный чат (общий тумблер в настройках).'],
      ],
    },
    {
      title: 'CRM',
      items: [
        ['Карточка контакта', 'кнопка CRM в тулбаре: заметки «о нём» и «моя информация», статус hover-подсказки.'],
        ['Hover', 'наведение на чат в списке показывает вашу заметку по контакту.'],
      ],
    },
    {
      title: 'Горячие клавиши',
      hotkeys: [
        ['Cmd/Ctrl+K', 'глобальный поиск контакта'],
        ['Cmd/Ctrl+U', 'следующий непрочитанный чат (по всем аккаунтам)'],
        ['Cmd/Ctrl+T', 'панель шаблонов'],
        ['Cmd/Ctrl+клик по ссылке', 'открыть наоборот: сплит-панель ↔ внешний браузер'],
        ['/', 'слэш-шаблоны в поле ввода WhatsApp'],
        ['Cmd/Ctrl+R', 'перезагрузить активный WhatsApp'],
        ['Cmd+Alt+Shift+I', 'DevTools активного webview'],
        ['Esc', 'закрыть верхний открытый слой интерфейса'],
        ['F1', 'эта справка'],
      ],
    },
  ];

  let _overlay = null;
  let _open = false;

  function build() {
    const overlay = document.createElement('div');
    overlay.id = 'help-overlay';
    overlay.className = 'help-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Справка OmniDeck');

    const box = document.createElement('div');
    box.className = 'help-box';

    const head = document.createElement('div');
    head.className = 'help-head';
    const title = document.createElement('h2');
    title.textContent = 'Справка OmniDeck';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-close';
    close.textContent = '✕';
    close.title = 'Закрыть (Esc)';
    close.addEventListener('click', () => hide());
    head.append(title, close);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'help-body';
    for (const section of SECTIONS) {
      const sec = document.createElement('section');
      sec.className = 'help-section';
      const h = document.createElement('h3');
      h.textContent = section.title;
      sec.appendChild(h);
      if (section.items) {
        for (const [term, desc] of section.items) {
          const row = document.createElement('p');
          const b = document.createElement('b');
          b.textContent = term + ': ';
          row.appendChild(b);
          row.appendChild(document.createTextNode(desc));
          sec.appendChild(row);
        }
      }
      if (section.hotkeys) {
        const table = document.createElement('div');
        table.className = 'help-hotkeys';
        for (const [keys, desc] of section.hotkeys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = keys;
          const span = document.createElement('span');
          span.textContent = desc;
          table.append(kbd, span);
        }
        sec.appendChild(table);
      }
      body.appendChild(sec);
    }
    box.appendChild(body);
    overlay.appendChild(box);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) hide();
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function show() {
    if (!_overlay) _overlay = build();
    _overlay.classList.remove('hidden');
    _open = true;
  }

  function hide() {
    _overlay?.classList.add('hidden');
    _open = false;
  }

  function toggle() { if (_open) hide(); else show(); }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key === 'Escape' && _open) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  }, true);

  export const WaDeckHelp = { show, hide, toggle, isOpen: () => _open };
  window.WaDeckHelp = WaDeckHelp;
