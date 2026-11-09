/**
 * Phone-first helpers shared by the run pages (index.html, sets.html). Styles in mobile.css.
 *
 * Both helpers enhance markup that already works rather than replacing it, so every existing
 * reader keeps working unchanged: a collapsed hint is the same <p> moved inside a <details>, and
 * the checkbox picker writes its state back into the original <select multiple>, which stays the
 * source of truth for selectedOptions and 'change' listeners.
 */
window.MobileUI = (function () {
  'use strict';

  /** Explanations shorter than this stay visible; they cost a line, not a screen. */
  const COLLAPSE_MIN_CHARS = 100;

  /**
   * Folds long explanation paragraphs behind a one-line "ⓘ" summary showing their opening words.
   * Runs of adjacent hints fold into one toggle. Hints with an id are skipped: those are live
   * status lines the code rewrites (errors, counts, measurements), and must stay in view.
   */
  function collapseHints(root) {
    const done = new Set();
    const candidates = Array.from((root || document).querySelectorAll('p.hint, ul.hint'))
      .filter((el) => !el.id && !el.closest('details.info, .settings-field, .calib-wizard'));
    for (const el of candidates) {
      if (done.has(el)) continue;
      const group = [el];
      let next = el.nextElementSibling;
      while (next && candidates.includes(next)) { group.push(next); next = next.nextElementSibling; }
      group.forEach((g) => done.add(g));
      const text = group.map((g) => g.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length < COLLAPSE_MIN_CHARS) continue;

      const details = document.createElement('details');
      details.className = 'info';
      const summary = document.createElement('summary');
      const icon = document.createElement('i');
      icon.className = 'i';
      icon.textContent = 'i';
      const gist = document.createElement('span');
      gist.className = 'gist';
      gist.textContent = text.split(/(?<=[.!?—:])\s/)[0];
      summary.append(icon, gist);
      details.appendChild(summary);
      el.parentNode.insertBefore(details, el);
      group.forEach((g) => details.appendChild(g));
    }
  }

  /**
   * Replaces a <select multiple> on screen with a list of large checkboxes, with a filter box
   * once the list is long. The select is hidden but kept: ticking a box sets option.selected and
   * fires 'change' on the select, exactly as picking in the native control did.
   *
   * Selected entries are pinned to the top, but only when the list is (re)built, never on each
   * tap, so a row never jumps out from under a finger. Rebuilds happen automatically when the
   * page replaces the select's options; after setting option.selected from code, call sync().
   */
  function checkboxPicker(select, opts) {
    const o = Object.assign({ filterAt: 10, noun: ['selected', 'selected'] }, opts);
    select.classList.add('picker-source');
    const box = document.createElement('div');
    box.className = 'picker';
    box.innerHTML = '<div class="picker-head"><input type="search" placeholder="Filter" aria-label="Filter">' +
      '<span class="count"></span><button type="button" class="secondary">Clear</button></div><div class="picker-list"></div>';
    select.after(box);
    const head = box.querySelector('.picker-head');
    const filter = head.querySelector('input');
    const count = head.querySelector('.count');
    const clear = head.querySelector('button');
    const list = box.querySelector('.picker-list');

    function updateCount() {
      const n = Array.from(select.options).filter((x) => x.selected).length;
      count.textContent = n ? n + ' ' + o.noun[n === 1 ? 0 : 1] : '';
      clear.hidden = n === 0;
    }

    function render() {
      const options = Array.from(select.options);
      filter.hidden = options.length < o.filterAt;
      head.hidden = options.length === 0;
      const ordered = options.filter((x) => x.selected).concat(options.filter((x) => !x.selected));
      list.innerHTML = '';
      if (!options.length) {
        list.innerHTML = '<div class="picker-empty">Nothing to choose yet.</div>';
      }
      for (const opt of ordered) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = opt.selected;
        label.classList.toggle('on', opt.selected);
        label.append(cb, document.createTextNode(opt.textContent));
        cb.addEventListener('change', () => {
          opt.selected = cb.checked;
          label.classList.toggle('on', cb.checked);
          updateCount();
          select.dispatchEvent(new Event('change'));
        });
        label._option = opt;
        list.appendChild(label);
      }
      applyFilter();
      updateCount();
    }

    function applyFilter() {
      const q = filter.value.trim().toLowerCase();
      for (const label of list.querySelectorAll('label')) {
        label.hidden = !!q && !label.textContent.toLowerCase().includes(q);
      }
    }

    function sync() {
      for (const label of list.querySelectorAll('label')) {
        const on = label._option.selected;
        label.querySelector('input').checked = on;
        label.classList.toggle('on', on);
      }
      updateCount();
    }

    filter.addEventListener('input', applyFilter);
    clear.addEventListener('click', () => {
      Array.from(select.options).forEach((x) => { x.selected = false; });
      sync();
      select.dispatchEvent(new Event('change'));
    });
    new MutationObserver(render).observe(select, { childList: true });
    render();
    return { sync, render };
  }

  return { collapseHints, checkboxPicker };
})();
