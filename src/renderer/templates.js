  function normalizeText(value) {
    return String(value || '').replace(/\r/g, '');
  }

  function createTemplateController(ctx) {
    const {
      state,
      els,
      setStatus,
      insertTextToActiveChat,
      onChange,
    } = ctx;

    let selectedTemplateId = '';
    let isBound = false;

    const byId = (id) => state.templates.find((tpl) => tpl.id === id) || null;
    const notifyChange = () => {
      if (typeof onChange !== 'function') return;
      try { onChange(); } catch (e) { console.warn('[tmpl:onChange]', e); }
    };

    function renderSelect() {
      if (!els.templateSelect) return;
      const previous = selectedTemplateId;
      els.templateSelect.innerHTML = '';

      const createOption = (value, text) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        return option;
      };

      els.templateSelect.appendChild(createOption('', 'Новый шаблон'));

      for (const tpl of state.templates) {
        els.templateSelect.appendChild(createOption(tpl.id, tpl.title || 'Без названия'));
      }

      if (previous && byId(previous)) {
        selectedTemplateId = previous;
      } else {
        selectedTemplateId = '';
      }
      els.templateSelect.value = selectedTemplateId;

      const summary = document.querySelector('#templates-settings-card > summary');
      if (summary) {
        summary.textContent = state.templates.length
          ? 'Общие шаблоны (' + state.templates.length + ')'
          : 'Общие шаблоны';
      }
    }

    function fillEditorFromTemplate(template) {
      if (!els.templateTitle || !els.templateText) return;
      if (!template) {
        els.templateTitle.value = '';
        if (els.templateCategory) els.templateCategory.value = '';
        els.templateText.value = '';
        updateCategoryDatalist();
        return;
      }
      els.templateTitle.value = String(template.title || '');
      if (els.templateCategory) els.templateCategory.value = String(template.category || '');
      els.templateText.value = String(template.text || '');
      updateCategoryDatalist();
    }

    function readEditorPayload() {
      return {
        id: selectedTemplateId,
        title: String(els.templateTitle?.value || '').trim(),
        category: String(els.templateCategory?.value || '').trim(),
        text: normalizeText(els.templateText?.value || ''),
      };
    }

    function updateCategoryDatalist() {
      const categories = [...new Set(
        state.templates
          .map((tpl) => String(tpl.category || '').trim())
          .filter(Boolean)
      )].sort((a, b) => a.localeCompare(b, 'ru'));

      // Native <datalist> — kept for keyboard autocomplete (↑/↓ while typing).
      // Can't be styled (it's browser system UI).
      if (els.templateCategoryList) {
        els.templateCategoryList.innerHTML = '';
        for (const cat of categories) {
          const option = document.createElement('option');
          option.value = cat;
          els.templateCategoryList.appendChild(option);
        }
      }

      // Styled chip row — matches the app's theme and always visible. Click a
      // chip to fill the input with that category.
      const chipsHost = document.getElementById('template-category-chips');
      if (chipsHost) {
        chipsHost.innerHTML = '';
        for (const cat of categories) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'tmpl-category-chip';
          chip.textContent = cat;
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            if (els.templateCategory) {
              els.templateCategory.value = cat;
              els.templateCategory.dispatchEvent(new Event('input', { bubbles: true }));
              els.templateCategory.focus();
            }
          });
          chipsHost.appendChild(chip);
        }
      }
    }

    function upsertStateTemplates(nextTemplates) {
      state.templates = Array.isArray(nextTemplates) ? nextTemplates.map((tpl) => ({ ...tpl })) : [];
    }

    async function saveCurrentTemplate() {
      const payload = readEditorPayload();
      if (!payload.text.trim()) {
        setStatus('Шаблон: введите текст');
        return;
      }

      const response = await window.waDeck.saveTemplate(payload);
      if (!response?.ok) {
        const map = {
          template_text_required: 'Введите текст шаблона',
          template_not_found: 'Шаблон не найден',
        };
        setStatus(`Шаблон: ${map[response?.error] || response?.error || 'ошибка сохранения'}`);
        return;
      }

      upsertStateTemplates(response.templates);
      selectedTemplateId = String(response.template?.id || '');
      renderSelect();
      fillEditorFromTemplate(byId(selectedTemplateId));
      setStatus('Шаблон сохранён');
      // Форму закрываем ТОЛЬКО здесь, по факту успеха: при ошибке юзер
      // остаётся в форме с набранным текстом
      try { window._hideTemplateEditForm?.(); } catch { /* ignore */ }
      notifyChange();
    }

    async function deleteCurrentTemplate() {
      if (!selectedTemplateId) {
        setStatus('Шаблон: выберите шаблон для удаления');
        return;
      }
      const response = await window.waDeck.deleteTemplate(selectedTemplateId);
      if (!response?.ok) {
        setStatus(`Шаблон: ${response?.error || 'ошибка удаления'}`);
        return;
      }

      upsertStateTemplates(response.templates);
      selectedTemplateId = '';
      renderSelect();
      fillEditorFromTemplate(null);
      setStatus('Шаблон удалён');
      try { window._hideTemplateEditForm?.(); } catch { /* ignore */ }
      notifyChange();
    }

    async function insertIntoChat() {
      const text = normalizeText(els.templateText?.value || '').trim();
      if (!text) {
        setStatus('Шаблон: нет текста для вставки');
        return;
      }

      const result = await insertTextToActiveChat(text);
      if (!result?.ok) {
        setStatus(`Шаблон: не удалось вставить в чат (${result?.error || 'insert_failed'})`);
        return;
      }
      setStatus('Шаблон вставлен в активный чат');
    }

    function onTemplateSelected() {
      selectedTemplateId = String(els.templateSelect?.value || '').trim();
      fillEditorFromTemplate(byId(selectedTemplateId));
    }

    function newTemplate() {
      selectedTemplateId = '';
      if (els.templateSelect) {
        els.templateSelect.value = '';
      }
      fillEditorFromTemplate(null);
      setStatus('Новый шаблон');
    }

    function bind() {
      if (isBound) return;
      isBound = true;

      els.templateSelect?.addEventListener('change', onTemplateSelected);
      // Disable the save button for the duration of the request so a double
      // click cannot create two templates.
      els.templateSave?.addEventListener('click', async () => {
        if (els.templateSave.disabled) return;
        els.templateSave.disabled = true;
        try {
          await saveCurrentTemplate();
        } catch (err) {
          console.error(err);
        } finally {
          els.templateSave.disabled = false;
        }
      });
      els.templateDelete?.addEventListener('click', () => deleteCurrentTemplate().catch(console.error));
      els.templateNew?.addEventListener('click', newTemplate);
      els.templateToChat?.addEventListener('click', () => insertIntoChat().catch(console.error));
    }

    async function init(initialTemplates) {
      upsertStateTemplates(initialTemplates);
      if (!state.templates.length) {
        const response = await window.waDeck.listTemplates();
        if (response?.ok) {
          upsertStateTemplates(response.templates);
        }
      }
      renderSelect();
      fillEditorFromTemplate(byId(selectedTemplateId));
      updateCategoryDatalist();
    }

    return {
      bind,
      init,
    };
  }

  export const WaDeckTemplatesModule = {
    createTemplateController,
  };
  window.WaDeckTemplatesModule = WaDeckTemplatesModule;
