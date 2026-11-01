import { describe, expect, it } from 'vitest';
import {
  COLS,
  WIDGETS,
  WIDGET_IDS,
  defaultPrefs,
  hideWidget,
  minWidth,
  sanitizePrefs,
  showWidget,
  withLayout,
  type Breakpoint,
  type Cell,
  type DashboardPrefs,
} from './layout.js';

const BPS = Object.keys(COLS) as Breakpoint[];

const overlaps = (a: Cell, b: Cell) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function expectValid(prefs: DashboardPrefs) {
  for (const bp of BPS) {
    const cells = prefs.layouts[bp];
    const ids = cells.map((c) => c.i);
    expect(new Set(ids).size).toBe(ids.length);
    // Every widget is either placed or hidden, never both.
    for (const id of WIDGET_IDS) expect(ids.includes(id)).toBe(!prefs.hidden.includes(id));
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(COLS[bp]);
      expect(c.w).toBeGreaterThanOrEqual(minWidth(c.i, bp));
      expect(c.h).toBeGreaterThanOrEqual(WIDGETS[c.i].minH);
    }
  }
}

describe('default dashboard', () => {
  it('places every visible widget on every grid without overlaps', () => {
    const prefs = defaultPrefs();
    expectValid(prefs);
    for (const bp of BPS) {
      const cells = prefs.layouts[bp];
      for (const a of cells)
        for (const b of cells)
          if (a !== b) expect(overlaps(a, b), `${a.i}/${b.i} ${bp}`).toBe(false);
    }
  });

  it('starts with the failures tile hidden, ready to add', () => {
    expect(defaultPrefs().hidden).toEqual(['errors']);
  });

  it('fills each row of headline tiles exactly on the wide grid', () => {
    const tiles = defaultPrefs().layouts.lg.filter((c) => c.y === 0);
    expect(tiles.reduce((n, c) => n + c.w, 0)).toBe(COLS.lg);
  });
});

describe('sanitizePrefs', () => {
  it('falls back to the default for anything that is not an object', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      expect(sanitizePrefs(raw).layouts.lg).toEqual(defaultPrefs().layouts.lg);
    }
  });

  it('round-trips a valid arrangement unchanged', () => {
    const prefs = hideWidget(defaultPrefs(), 'topTools');
    expect(sanitizePrefs(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs);
  });

  it('drops unknown widgets, duplicates and malformed cells, then re-adds what is missing', () => {
    const prefs = sanitizePrefs({
      hidden: ['errors', 'nonsense'],
      layouts: {
        lg: [
          { i: 'activity', x: 0, y: 0, w: 8, h: 8 },
          { i: 'activity', x: 4, y: 20, w: 8, h: 8 },
          { i: 'evil', x: 0, y: 0, w: 1, h: 1 },
          { i: 'health', x: 'a', y: 0, w: 4, h: 8 },
          null,
        ],
      },
    });
    expectValid(prefs);
    expect(prefs.hidden).toEqual(['errors']);
    const lg = prefs.layouts.lg;
    expect(lg[0]).toEqual({ i: 'activity', x: 0, y: 0, w: 8, h: 8 });
    // Health was malformed, so it comes back at the bottom with its default size.
    const health = lg.find((c) => c.i === 'health')!;
    expect(health.y).toBeGreaterThanOrEqual(8);
  });

  it('clamps sizes to the grid and to each widget minimum', () => {
    const prefs = sanitizePrefs({
      hidden: [],
      layouts: {
        lg: [
          { i: 'activity', x: 10, y: 0, w: 99, h: 1 },
          { i: 'prompts', x: -5, y: -3, w: 0, h: 999 },
        ],
      },
    });
    expectValid(prefs);
    const [activity, prompts] = prefs.layouts.lg;
    expect(activity).toMatchObject({ x: 0, w: 12, h: WIDGETS.activity.minH });
    expect(prompts).toMatchObject({ x: 0, y: 0, w: WIDGETS.prompts.minW, h: 60 });
  });

  it('uses the default arrangement for a grid width with nothing saved', () => {
    const prefs = sanitizePrefs({ hidden: ['errors'], layouts: { lg: defaultPrefs().layouts.lg } });
    expect(prefs.layouts.md).toEqual(defaultPrefs().layouts.md);
  });

  it('keeps a hidden widget off every grid even if a cell for it was saved', () => {
    const prefs = sanitizePrefs({
      hidden: ['health', 'errors'],
      layouts: defaultPrefs().layouts,
    });
    expectValid(prefs);
    for (const bp of BPS) expect(prefs.layouts[bp].some((c) => c.i === 'health')).toBe(false);
  });
});

describe('showing and hiding widgets', () => {
  it('hides a widget on every grid and brings it back at the bottom', () => {
    const hidden = hideWidget(defaultPrefs(), 'activity');
    expectValid(hidden);
    expect(hidden.hidden).toContain('activity');

    const shown = showWidget(hidden, 'activity');
    expectValid(shown);
    for (const bp of BPS) {
      const cells = shown.layouts[bp];
      const added = cells.find((c) => c.i === 'activity')!;
      const others = cells.filter((c) => c.i !== 'activity');
      expect(added.y).toBe(Math.max(...others.map((c) => c.y + c.h)));
      expect(added.x).toBe(0);
    }
  });

  it('adds a default-hidden widget with a sensible size', () => {
    const shown = showWidget(defaultPrefs(), 'errors');
    expectValid(shown);
    expect(shown.layouts.lg.find((c) => c.i === 'errors')).toMatchObject({ w: 2, h: 3 });
    expect(shown.layouts.sm.find((c) => c.i === 'errors')).toMatchObject({ w: 1 });
  });

  it('is a no-op to hide a hidden widget or show a visible one', () => {
    const prefs = defaultPrefs();
    expect(showWidget(prefs, 'activity')).toBe(prefs);
    expect(hideWidget(prefs, 'errors')).toBe(prefs);
  });
});

describe('withLayout', () => {
  it('takes the grid arrangement for one width and ignores unknown items', () => {
    const prefs = defaultPrefs();
    const next = withLayout(prefs, 'lg', [
      { i: 'activity', x: 4, y: 0, w: 8, h: 8 },
      { i: '__dropping-elem__', x: 0, y: 0, w: 1, h: 1 },
      { i: 'errors', x: 0, y: 0, w: 2, h: 3 },
    ]);
    expect(next.layouts.lg).toEqual([{ i: 'activity', x: 4, y: 0, w: 8, h: 8 }]);
    expect(next.layouts.md).toBe(prefs.layouts.md);
  });
});
