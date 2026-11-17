/**
 * The Lorcana | Magic switch shared by Card Sorter, Set Builder and Run History.
 *
 * The chosen game is remembered on this phone (like the other remembered run choices), so it
 * carries between pages and survives a reload. Each page still keeps its own hidden game <select>
 * as the source of truth for what gets posted; this only drives it.
 *
 * What a game switch changes, and why only these: the server keeps a separate copy of the
 * recognition thresholds and run defaults per game (settings.ts GAME_SCOPED_KEYS), so every
 * settings read and write goes through settingsUrl(). Capture crop, platform baseline, sound and
 * the Bluetooth link describe the rig, not the cards, and are shared.
 */
window.GameSwitch = (function () {
  const GAMES = [
    { id: 71, key: 'lorcana', label: 'Lorcana' },
    // Secret Lair x MSCHF: The Zeta Set, preselected the first time Magic is used on a phone.
    { id: 1, key: 'magic', label: 'Magic', defaultSetIds: [24836] },
  ];
  const STORAGE_KEY = 'cs.game.v1';
  const byId = (id) => GAMES.find((g) => g.id === Number(id)) || GAMES[0];

  function current() {
    try {
      const v = Number(localStorage.getItem(STORAGE_KEY));
      if (GAMES.some((g) => g.id === v)) return v;
    } catch (e) { /* storage unavailable: fall through to Lorcana */ }
    return GAMES[0].id;
  }

  function apply(id) {
    document.documentElement.dataset.game = byId(id).key;
  }

  function choose(id) {
    try { localStorage.setItem(STORAGE_KEY, String(id)); } catch (e) { /* not remembered */ }
    apply(id);
  }

  /** `/api/settings` → `/api/settings?game_id=1`, so the server reads/writes this game's copy. */
  function settingsUrl(path) {
    return path + (path.includes('?') ? '&' : '?') + 'game_id=' + current();
  }

  /** Per-game localStorage key. Lorcana keeps the original key, so choices remembered before the
   *  switch existed are still found. */
  function storageKey(base) {
    return current() === GAMES[0].id ? base : base + '.g' + current();
  }

  // The accent colour is the at-a-glance tell of which game is loaded, readable from across the
  // room the same way the DRY RUN badge is. Injected here so the three pages need no CSS edits.
  const style = document.createElement('style');
  style.textContent = `
    :root[data-game="magic"] { --accent: #d97706; }
    /* Title and switch share the first header row; mobile.css would otherwise give the h1 the
       whole row and push the switch onto a line of its own. */
    header:has(.game-switch) h1 { width: auto; flex: 1 1 auto; margin-right: 0; }
    #game-switch-slot { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    /* The pages style label/select with display:block, and an author display rule beats the
       [hidden] attribute — the trap that once left a DRY RUN badge showing permanently. */
    label[for="game-select"][hidden], #game-select[hidden] { display: none !important; }
    .game-switch { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; flex: none; }
    .game-switch button {
      background: transparent; color: var(--muted); border: none; padding: 0.4rem 0.75rem;
      font-size: 0.85rem; font-weight: 600; cursor: pointer; min-height: 36px;
    }
    .game-switch button[aria-pressed="true"] { background: var(--accent); color: #fff; }
    .game-switch button:disabled { cursor: not-allowed; }
    .game-switch-note { font-size: 0.75rem; color: var(--yellow); }
  `;
  document.head.appendChild(style);
  apply(current());

  /**
   * Puts the switch into `container` (the page header). `onChange(id)` runs after a switch;
   * `canSwitch()` returning a string vetoes it and shows that string — pages use it to refuse a
   * switch mid-run, where it would re-point thresholds under a pile already being sorted.
   */
  function mount(container, { onChange, canSwitch } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'game-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Game');
    const note = document.createElement('span');
    note.className = 'game-switch-note';

    const render = () => {
      for (const b of wrap.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.game) === current()));
    };
    for (const g of GAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.game = String(g.id);
      b.textContent = g.label;
      b.addEventListener('click', async () => {
        if (g.id === current()) return;
        const veto = canSwitch ? canSwitch() : null;
        if (veto) { note.textContent = veto; setTimeout(() => { note.textContent = ''; }, 4000); return; }
        note.textContent = '';
        choose(g.id);
        render();
        if (onChange) await onChange(g.id);
      });
      wrap.appendChild(b);
    }
    render();
    container.append(wrap, note);
    return { render };
  }

  return { GAMES, byId, current, choose, mount, settingsUrl, storageKey };
})();
