/**
 * The dashboard's widgets and where they sit. Kept free of React so the rules can be tested:
 * which widgets exist, their default places on each grid width, and how a saved arrangement is
 * read back without trusting it.
 */

export const BREAKPOINTS = { lg: 900, md: 560, sm: 0 } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;
export const COLS: Record<Breakpoint, number> = { lg: 12, md: 6, sm: 1 };
export const ROW_HEIGHT = 44;
export const MARGIN: [number, number] = [16, 16];

export const WIDGET_IDS = [
  'prompts',
  'toolCalls',
  'sessions',
  'projects',
  'models',
  'mcpTools',
  'errors',
  'activity',
  'health',
  'recent',
  'modelUsage',
  'topTools',
  'projectTable',
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export interface WidgetMeta {
  title: string;
  description: string;
  /** Smallest size, in grid cells on the 12-column grid, that still shows the content. */
  minW: number;
  minH: number;
  /** Off until someone adds it. */
  defaultHidden?: boolean;
}

export const WIDGETS: Record<WidgetId, WidgetMeta> = {
  prompts: { title: 'Prompts', description: 'Prompts sent in the last 7 days', minW: 2, minH: 3 },
  toolCalls: {
    title: 'Tool calls',
    description: 'Tools the agent ran in the last 7 days',
    minW: 2,
    minH: 3,
  },
  sessions: {
    title: 'Sessions',
    description: 'Sessions, and how many are running',
    minW: 2,
    minH: 3,
  },
  projects: { title: 'Projects', description: 'Project containers that are up', minW: 2, minH: 3 },
  models: { title: 'Models', description: 'Models offered by your providers', minW: 2, minH: 3 },
  mcpTools: { title: 'MCP tools', description: 'Tools your MCP servers expose', minW: 2, minH: 3 },
  errors: {
    title: 'Failures',
    description: 'Failed tool calls and pi crashes in the last 7 days',
    minW: 2,
    minH: 3,
    defaultHidden: true,
  },
  activity: {
    title: 'Activity',
    description: 'Prompts, tool calls or failures per day for two weeks',
    minW: 4,
    minH: 5,
  },
  health: {
    title: 'System health',
    description: 'Sandbox image, providers, GitHub, MCP and accounts',
    minW: 3,
    minH: 5,
  },
  recent: {
    title: 'Recent sessions',
    description: 'Sessions by latest activity',
    minW: 4,
    minH: 5,
  },
  modelUsage: {
    title: 'Sessions by model',
    description: 'Which models sessions were started with',
    minW: 3,
    minH: 3,
  },
  topTools: {
    title: 'Top tools',
    description: 'Most-called tools in the last 14 days',
    minW: 3,
    minH: 3,
  },
  projectTable: {
    title: 'Projects overview',
    description: 'Every project with its sessions and recent prompts',
    minW: 6,
    minH: 4,
  },
};

export interface Cell {
  i: WidgetId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Layouts = Record<Breakpoint, Cell[]>;

const cell = (i: WidgetId, x: number, y: number, w: number, h: number): Cell => ({ i, x, y, w, h });

/** The arrangement on a wide screen: headline numbers, then the charts, then the lists. */
const LG: Cell[] = [
  cell('prompts', 0, 0, 2, 3),
  cell('toolCalls', 2, 0, 2, 3),
  cell('sessions', 4, 0, 2, 3),
  cell('projects', 6, 0, 2, 3),
  cell('models', 8, 0, 2, 3),
  cell('mcpTools', 10, 0, 2, 3),
  cell('activity', 0, 3, 8, 7),
  cell('health', 8, 3, 4, 7),
  cell('recent', 0, 10, 7, 8),
  cell('modelUsage', 7, 10, 5, 4),
  cell('topTools', 7, 14, 5, 4),
  cell('projectTable', 0, 18, 12, 6),
];

const MD: Cell[] = [
  cell('prompts', 0, 0, 2, 3),
  cell('toolCalls', 2, 0, 2, 3),
  cell('sessions', 4, 0, 2, 3),
  cell('projects', 0, 3, 2, 3),
  cell('models', 2, 3, 2, 3),
  cell('mcpTools', 4, 3, 2, 3),
  cell('activity', 0, 6, 6, 7),
  cell('health', 0, 13, 6, 7),
  cell('recent', 0, 20, 6, 8),
  cell('modelUsage', 0, 28, 3, 5),
  cell('topTools', 3, 28, 3, 5),
  cell('projectTable', 0, 33, 6, 7),
];

/** Default height of each widget when stacked in a single column. */
const SM_HEIGHT: Record<WidgetId, number> = {
  prompts: 3,
  toolCalls: 3,
  sessions: 3,
  projects: 3,
  models: 3,
  mcpTools: 3,
  errors: 3,
  activity: 7,
  health: 8,
  recent: 8,
  modelUsage: 5,
  topTools: 5,
  projectTable: 8,
};

/** Size a widget takes when it is added on each grid. */
const ADD_SIZE: Record<Exclude<Breakpoint, 'sm'>, Record<WidgetId, [number, number]>> = {
  lg: {
    prompts: [2, 3],
    toolCalls: [2, 3],
    sessions: [2, 3],
    projects: [2, 3],
    models: [2, 3],
    mcpTools: [2, 3],
    errors: [2, 3],
    activity: [8, 7],
    health: [4, 7],
    recent: [7, 8],
    modelUsage: [5, 4],
    topTools: [5, 4],
    projectTable: [12, 6],
  },
  md: {
    prompts: [2, 3],
    toolCalls: [2, 3],
    sessions: [2, 3],
    projects: [2, 3],
    models: [2, 3],
    mcpTools: [2, 3],
    errors: [2, 3],
    activity: [6, 7],
    health: [6, 7],
    recent: [6, 8],
    modelUsage: [3, 5],
    topTools: [3, 5],
    projectTable: [6, 7],
  },
};

/** Minimum width scaled to a grid's column count (the metadata is for 12 columns). */
export function minWidth(id: WidgetId, bp: Breakpoint): number {
  return Math.max(1, Math.min(COLS[bp], Math.round((WIDGETS[id].minW * COLS[bp]) / 12)));
}

function addSize(id: WidgetId, bp: Breakpoint): [number, number] {
  return bp === 'sm' ? [1, SM_HEIGHT[id]] : ADD_SIZE[bp][id];
}

const bottom = (cells: Cell[]) => cells.reduce((n, c) => Math.max(n, c.y + c.h), 0);

/** Puts a widget below everything else on one grid. */
function appendCell(cells: Cell[], id: WidgetId, bp: Breakpoint): Cell[] {
  const [w, h] = addSize(id, bp);
  return [...cells, cell(id, 0, bottom(cells), w, h)];
}

export interface DashboardPrefs {
  layouts: Layouts;
  hidden: WidgetId[];
}

export function defaultPrefs(): DashboardPrefs {
  const hidden = WIDGET_IDS.filter((id) => WIDGETS[id].defaultHidden);
  const sm: Cell[] = [];
  for (const c of LG) sm.push(cell(c.i, 0, bottom(sm), 1, SM_HEIGHT[c.i]));
  return {
    layouts: { lg: LG.map((c) => ({ ...c })), md: MD.map((c) => ({ ...c })), sm },
    hidden,
  };
}

const isId = (v: unknown): v is WidgetId =>
  typeof v === 'string' && (WIDGET_IDS as readonly string[]).includes(v);
const int = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null;

/** Most rows a saved widget may claim; anything taller is clamped. */
const MAX_ROWS = 60;

/**
 * Reads saved preferences without trusting them: unknown widgets and malformed cells are dropped,
 * sizes are clamped to the grid and to each widget's minimum, duplicates keep their first place,
 * and any widget that is neither hidden nor placed is added at the bottom. Whatever is stored,
 * the result is a usable dashboard.
 */
export function sanitizePrefs(raw: unknown): DashboardPrefs {
  const fallback = defaultPrefs();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as { layouts?: unknown; hidden?: unknown };
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(isId))] : fallback.hidden;
  const savedLayouts =
    r.layouts && typeof r.layouts === 'object' ? (r.layouts as Record<string, unknown>) : {};

  const layouts = {} as Layouts;
  for (const bp of Object.keys(COLS) as Breakpoint[]) {
    const cols = COLS[bp];
    const saved = savedLayouts[bp];
    const seen = new Set<WidgetId>();
    let cells: Cell[] = [];
    if (Array.isArray(saved)) {
      for (const item of saved as Record<string, unknown>[]) {
        if (!item || typeof item !== 'object' || !isId(item.i)) continue;
        if (seen.has(item.i) || hidden.includes(item.i)) continue;
        const minW = minWidth(item.i, bp);
        const minH = WIDGETS[item.i].minH;
        const w = int(item.w, minW, cols);
        const h = int(item.h, minH, MAX_ROWS);
        const x = w === null ? null : int(item.x, 0, cols - w);
        const y = int(item.y, 0, 10_000);
        if (w === null || h === null || x === null || y === null) continue;
        seen.add(item.i);
        cells.push(cell(item.i, x, y, w, h));
      }
    } else {
      // No arrangement saved for this width yet: start from the default one.
      cells = fallback.layouts[bp].filter((c) => !hidden.includes(c.i));
      cells.forEach((c) => seen.add(c.i));
    }
    for (const id of WIDGET_IDS) {
      if (!seen.has(id) && !hidden.includes(id)) cells = appendCell(cells, id, bp);
    }
    layouts[bp] = cells;
  }
  return { layouts, hidden };
}

export function hideWidget(prefs: DashboardPrefs, id: WidgetId): DashboardPrefs {
  if (prefs.hidden.includes(id)) return prefs;
  const layouts = {} as Layouts;
  for (const bp of Object.keys(COLS) as Breakpoint[]) {
    layouts[bp] = prefs.layouts[bp].filter((c) => c.i !== id);
  }
  return { layouts, hidden: [...prefs.hidden, id] };
}

export function showWidget(prefs: DashboardPrefs, id: WidgetId): DashboardPrefs {
  if (!prefs.hidden.includes(id)) return prefs;
  const layouts = {} as Layouts;
  for (const bp of Object.keys(COLS) as Breakpoint[]) {
    layouts[bp] = appendCell(
      prefs.layouts[bp].filter((c) => c.i !== id),
      id,
      bp,
    );
  }
  return { layouts, hidden: prefs.hidden.filter((h) => h !== id) };
}

/** Takes the grid library's arrangement for one width, keeping only what the dashboard knows. */
export function withLayout(
  prefs: DashboardPrefs,
  bp: Breakpoint,
  items: readonly { i: string; x: number; y: number; w: number; h: number }[],
): DashboardPrefs {
  const cells = items
    .filter((c) => isId(c.i) && !prefs.hidden.includes(c.i as WidgetId))
    .map((c) => cell(c.i as WidgetId, c.x, c.y, c.w, c.h));
  return { ...prefs, layouts: { ...prefs.layouts, [bp]: cells } };
}

const STORAGE_VERSION = 1;
export const storageKey = (userId: number) => `pi-panel-dashboard:v${STORAGE_VERSION}:${userId}`;

export function loadPrefs(key: string): DashboardPrefs {
  try {
    const text = window.localStorage.getItem(key);
    return text ? sanitizePrefs(JSON.parse(text)) : defaultPrefs();
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(key: string, prefs: DashboardPrefs) {
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Storage is unavailable (private window, blocked): the arrangement lasts for this page only.
  }
}

export function clearPrefs(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing stored, or storage blocked: either way the default is what shows.
  }
}
