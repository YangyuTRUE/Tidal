/* Document-local select controls for Zotero's standalone chrome windows. */
(function (global) {
  'use strict';
  const XHTML = 'http://www.w3.org/1999/xhtml';

  function attach(document, ids) {
    const window = document.defaultView || global;
    const controls = new Map();
    let opened = null;

    function close(restoreFocus = false) {
      if (!opened) return;
      const control = opened;
      opened = null;
      control.list.hidden = true;
      control.button.setAttribute('aria-expanded', 'false');
      control.button.removeAttribute('aria-activedescendant');
      control.wrapper.classList.remove('is-open');
      if (restoreFocus && !control.button.disabled) control.button.focus();
    }

    for (const id of ids) {
      const select = document.getElementById(id);
      const wrapper = document.getElementById(id + '-select');
      const button = document.getElementById(id + '-button');
      const value = document.getElementById(id + '-value');
      const list = document.getElementById(id + '-listbox');
      if (!select || !wrapper || !button || !value || !list) throw new Error('设置选项组件不完整：' + id);
      const control = { select, wrapper, button, value, list, options: [], active: 0 };
      controls.set(id, control);

      function markActive(index) {
        const option = control.options[index];
        if (!option || option.source.disabled) return;
        control.active = index;
        for (let i = 0; i < control.options.length; i++) control.options[i].node.classList.toggle('is-active', i === index);
        if (opened === control) button.setAttribute('aria-activedescendant', option.node.id);
        if (opened === control && list.clientHeight) {
          const top = option.node.offsetTop, bottom = top + option.node.offsetHeight;
          if (top < list.scrollTop) list.scrollTop = top;
          else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
        }
      }

      function sync() {
        let selected = control.options.findIndex(option => option.source.value === select.value);
        value.textContent = selected < 0 ? '请选择' : control.options[selected].source.textContent;
        for (let i = 0; i < control.options.length; i++) {
          const option = control.options[i];
          option.node.setAttribute('aria-selected', String(i === selected));
          option.node.setAttribute('aria-disabled', String(Boolean(option.source.disabled)));
          option.node.classList.toggle('is-selected', i === selected);
        }
        button.disabled = select.disabled;
        button.setAttribute('aria-disabled', String(Boolean(select.disabled)));
        if (select.disabled && opened === control) close();
        if (opened !== control) markActive(Math.max(0, selected));
      }

      function open(index) {
        if (button.disabled || select.disabled) return;
        if (opened !== control) close();
        opened = control;
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        wrapper.classList.add('is-open');
        const bounds = button.getBoundingClientRect();
        const below = window.innerHeight - bounds.bottom - 12, above = bounds.top - 12;
        const upward = below < Math.min(280, list.scrollHeight) && above > below;
        list.dataset.side = upward ? 'above' : 'below';
        list.style.maxHeight = Math.max(72, Math.min(320, upward ? above : below)) + 'px';
        const selected = control.options.findIndex(option => option.source.value === select.value);
        markActive(index === undefined ? Math.max(0, selected) : index);
      }

      function choose(index, restoreFocus = true) {
        const option = control.options[index];
        if (!option || option.source.disabled || select.disabled || button.disabled) return;
        const previous = select.value;
        select.value = option.source.value;
        close(restoreFocus);
        sync();
        if (select.value !== previous) {
          select.dispatchEvent(new window.Event('input', { bubbles: true }));
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
      }

      function rebuild() {
        list.replaceChildren();
        control.options = Array.from(select.options, (source, index) => {
          const node = document.createElementNS(XHTML, 'div');
          node.id = id + '-option-' + index;
          node.className = 'pt-select-option';
          node.setAttribute('role', 'option');
          node.dataset.value = source.value;
          node.textContent = source.textContent;
          node.addEventListener('mousedown', event => event.preventDefault());
          // Showing a popup beneath a stationary pointer can emit mouseenter
          // (and zero-delta mousemove) after keyboard Home/End. Only actual
          // pointer movement may replace the keyboard's highlighted choice.
          node.addEventListener('mousemove', event => {
            if (opened === control && (event.movementX || event.movementY)) markActive(index);
          });
          node.addEventListener('click', () => { if (opened === control) choose(index); });
          list.appendChild(node);
          return { source, node };
        });
        sync();
      }

      control.sync = sync;
      control.setValue = next => {
        // Preserve valid languages from an older/custom configuration even if
        // they are not one of the short list of common UI choices.
        if (next && !Array.from(select.options).some(option => option.value === next)) {
          const option = document.createElementNS(XHTML, 'option');
          option.value = next; option.textContent = next;
          select.appendChild(option);
          rebuild();
        }
        select.value = next;
        sync();
      };
      button.addEventListener('click', () => {
        if (opened === control) close();
        else open();
      });
      button.addEventListener('keydown', event => {
        if (button.disabled || select.disabled) return;
        const key = event.key;
        if (key === 'Escape') { if (opened === control) { event.preventDefault(); close(true); } return; }
        if (key === 'Tab') { if (opened === control) choose(control.active, false); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
          event.preventDefault();
          if (key === 'Enter' || key === ' ') {
            if (opened === control) choose(control.active);
            else open();
          } else if (key === 'Home' || key === 'End') {
            const index = key === 'Home' ? 0 : control.options.length - 1;
            if (opened === control) markActive(index); else open(index);
          } else if (opened !== control) open();
          else markActive(Math.max(0, Math.min(control.options.length - 1, control.active + (key === 'ArrowDown' ? 1 : -1))));
        }
      });
      select.addEventListener('change', sync);
      rebuild();
    }

    document.addEventListener('mousedown', event => { if (opened && !opened.wrapper.contains(event.target)) close(); }, true);
    document.addEventListener('focusin', event => { if (opened && !opened.wrapper.contains(event.target)) close(); });
    window.addEventListener('blur', () => close());
    window.addEventListener('resize', () => close());
    window.addEventListener('unload', () => close(), { once: true });

    return {
      close: () => close(),
      sync: () => { for (const control of controls.values()) control.sync(); },
      setValue: (id, value) => {
        const control = controls.get(id);
        if (!control) return false;
        control.setValue(String(value ?? '')); return true;
      }
    };
  }
  global.PTSelectControls = Object.freeze({ attach });
})(globalThis);
