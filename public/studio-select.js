'use strict';
// Native selects remain the form's source of truth. The two small option lists
// share one anchored popup, keyboard behavior and visual treatment.
(() => {
  let opened = null;
  function enhance(select) {
    const field = select.parentElement, label = field.querySelector('label');
    const trigger = document.createElement('button'), value = document.createElement('span');
    const arrow = document.createElement('span'), menu = document.createElement('ul');
    trigger.type = 'button'; trigger.id = `${select.id}-trigger`; trigger.className = 'custom-select-trigger';
    value.id = `${select.id}-value`; arrow.className = 'custom-select-arrow'; arrow.setAttribute('aria-hidden', 'true');
    trigger.append(value, arrow); trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
    menu.id = `${select.id}-menu`; menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', label.id);
    menu.setAttribute('popover', 'manual'); menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    const options = Array.from(select.options);
    const items = options.map((option, index) => {
      const li = document.createElement('li'), text = document.createElement('span'), check = document.createElement('span');
      li.id = `${select.id}-option-${index}`; li.setAttribute('role', 'option');
      text.textContent = option.textContent; check.textContent = '✓'; check.className = 'option-check'; check.setAttribute('aria-hidden', 'true');
      li.append(text, check); menu.append(li);
      li.addEventListener('pointermove', () => activate(index));
      li.addEventListener('click', () => choose(index));
      return li;
    });
    let active = select.selectedIndex, visible = false, typed = '', typedAt = 0;
    const dialog = select.closest('dialog');
    field.append(trigger, menu); select.hidden = true; label.htmlFor = trigger.id;
    function sync() {
      value.textContent = options[select.selectedIndex]?.textContent || '';
      trigger.disabled = select.disabled;
      items.forEach((li, i) => li.setAttribute('aria-selected', String(i === select.selectedIndex)));
      if (select.disabled) close();
    }
    function position() {
      if (!visible) return;
      const rect = trigger.getBoundingClientRect();
      const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : innerHeight;
      menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 8}px`; menu.style.width = `${rect.width}px`;
      menu.style.maxHeight = `${Math.max(44, Math.min(220, viewportBottom - rect.bottom - 20))}px`;
    }
    function activate(index, scroll = false) {
      active = index; items.forEach((li, i) => li.classList.toggle('is-active', i === index));
      trigger.setAttribute('aria-activedescendant', items[index].id);
      if (scroll) items[index].scrollIntoView({ block: 'nearest' });
    }
    function open() {
      if (trigger.disabled || visible) return;
      opened?.close(); visible = true; opened = { close };
      const rect = trigger.getBoundingClientRect();
      const bottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : innerHeight;
      // Make room in a short dialog instead of flipping one menu above its field.
      if (dialog && bottom - rect.bottom < 172) dialog.scrollTop += 172 - (bottom - rect.bottom);
      menu.hidden = false; position();
      if (typeof menu.showPopover === 'function') menu.showPopover();
      trigger.setAttribute('aria-expanded', 'true'); activate(select.selectedIndex);
    }
    function close() {
      if (!visible) return;
      visible = false;
      if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover();
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
      if (opened?.close === close) opened = null;
    }
    function choose(index) {
      select.selectedIndex = index; sync(); close(); trigger.focus({ preventScroll: true });
      select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.addEventListener('click', () => visible ? close() : open());
    menu.addEventListener('pointerdown', event => event.preventDefault());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); visible ? choose(active) : open(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const wasOpen = visible; open();
        if (event.key === 'Home') activate(0, true);
        else if (event.key === 'End') activate(items.length - 1, true);
        else if (wasOpen) activate((active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length, true);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); const now = Date.now(); typed = now - typedAt > 700 ? event.key : typed + event.key; typedAt = now;
        const match = options.findIndex(option => option.textContent.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase()));
        if (match >= 0) { open(); activate(match, true); }
      }
    });
    trigger.addEventListener('blur', () => close());
    document.addEventListener('pointerdown', event => { if (!trigger.contains(event.target) && !menu.contains(event.target)) close(); });
    document.addEventListener('scroll', position, true); window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    dialog?.addEventListener('close', close);
    dialog?.addEventListener('cancel', event => { if (visible) { event.preventDefault(); close(); } });
    select.addEventListener('change', sync);
    select.form?.addEventListener('reset', () => queueMicrotask(sync));
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'] });
    sync(); return sync;
  }
  window.JtgStudioSelect = { enhance };
})();
