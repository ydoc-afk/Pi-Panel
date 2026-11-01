import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconCheck,
  IconLayoutDashboard,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconSettings,
} from '@tabler/icons-react';
import {
  Responsive,
  useContainerWidth,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from 'react-grid-layout';
import { GridBackground } from 'react-grid-layout/extras';
import { getDashboard, type DashboardData } from '../api.js';
import { ErrorText, PageHeader } from '../ui.js';
import { timeAgo } from './charts.js';
import {
  BREAKPOINTS,
  COLS,
  MARGIN,
  ROW_HEIGHT,
  WIDGETS,
  WIDGET_IDS,
  clearPrefs,
  defaultPrefs,
  hideWidget,
  loadPrefs,
  minWidth,
  savePrefs,
  showWidget,
  storageKey,
  withLayout,
  type Breakpoint,
  type DashboardPrefs,
  type WidgetId,
} from './layout.js';
import { WIDGET_COMPONENTS, type DashboardNav } from './widgets.js';

const REFRESH_MS = 30_000;

const breakpointFor = (width: number): Breakpoint =>
  width >= BREAKPOINTS.lg ? 'lg' : width >= BREAKPOINTS.md ? 'md' : 'sm';

/** Fetches the dashboard now and every 30 seconds while the page is visible. */
function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getDashboard());
      setError('');
    } catch (e) {
      // Keep showing the last good data; only say what went wrong.
      setError(e instanceof Error ? e.message : 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { data, error, loading, reload: load };
}

/** Re-renders every half minute so "updated 2 minutes ago" stays true. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Dashboard({
  userId,
  isAdmin,
  nav,
}: {
  userId: number;
  isAdmin: boolean;
  nav: DashboardNav;
}) {
  const key = storageKey(userId);
  const [prefs, setPrefs] = useState<DashboardPrefs>(() => loadPrefs(key));
  const [editing, setEditing] = useState(false);
  const { data, error, loading, reload } = useDashboardData();
  const { width, containerRef, mounted } = useContainerWidth();
  const now = useNow();
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const update = useCallback(
    (next: DashboardPrefs) => {
      setPrefs(next);
      savePrefs(key, next);
    },
    [key],
  );

  const bp = breakpointFor(width);
  const visible = WIDGET_IDS.filter((id) => !prefs.hidden.includes(id));
  const hidden = prefs.hidden;

  // The grid library reads min sizes and lock state from each item.
  const layouts = useMemo(() => {
    const out = {} as ResponsiveLayouts<Breakpoint>;
    for (const b of Object.keys(COLS) as Breakpoint[]) {
      out[b] = prefs.layouts[b].map((c): LayoutItem => ({
        ...c,
        minW: minWidth(c.i, b),
        minH: WIDGETS[c.i].minH,
      }));
    }
    return out;
  }, [prefs.layouts]);

  const rows = prefs.layouts[bp].reduce((n, c) => Math.max(n, c.y + c.h), 0);

  const onLayoutChange = useCallback(
    (_current: Layout, all: Partial<Record<string, Layout>>) => {
      // The grid also reports its own compaction on load and when the width crosses a
      // breakpoint; only a person's change in edit mode is saved. Each width's arrangement is
      // taken from the grid's own record for that width, never matched up by the page width,
      // which can be stale when the grid switches breakpoints.
      if (!editingRef.current) return;
      setPrefs((cur) => {
        let next = cur;
        for (const b of Object.keys(COLS) as Breakpoint[]) {
          const cells = all[b];
          if (cells) next = withLayout(next, b, cells);
        }
        savePrefs(key, next);
        return next;
      });
    },
    [key],
  );

  const header = (
    <PageHeader
      icon={IconLayoutDashboard}
      title="Dashboard"
      description="Activity across every project, at a glance. Customize it to keep what you use in view."
      action={
        editing ? (
          <Group gap="xs">
            <Menu position="bottom-end" width={300} shadow="md" radius="md">
              <Menu.Target>
                <Button
                  variant="default"
                  leftSection={<IconPlus size={16} />}
                  disabled={hidden.length === 0}
                >
                  Add widget
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {hidden.map((id) => (
                  <Menu.Item key={id} onClick={() => update(showWidget(prefs, id))}>
                    <Text size="sm" fw={600}>
                      {WIDGETS[id].title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {WIDGETS[id].description}
                    </Text>
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Button
              variant="default"
              leftSection={<IconRestore size={16} />}
              onClick={() => {
                clearPrefs(key);
                setPrefs(defaultPrefs());
              }}
            >
              Reset
            </Button>
            <Button leftSection={<IconCheck size={16} />} onClick={() => setEditing(false)}>
              Done
            </Button>
          </Group>
        ) : (
          <Group gap="xs">
            {data && (
              <Text size="xs" c="dimmed">
                Updated {timeAgo(data.generatedAt, Math.max(now, data.generatedAt))}
              </Text>
            )}
            <Tooltip label="Refresh now" openDelay={300}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Refresh dashboard"
                loading={loading}
                onClick={() => void reload()}
              >
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button
              variant="default"
              leftSection={<IconSettings size={16} />}
              onClick={() => setEditing(true)}
            >
              Customize
            </Button>
          </Group>
        )
      }
    />
  );

  return (
    <Stack gap="lg">
      {header}
      {editing && (
        <Alert variant="light" radius="lg" icon={<IconLayoutDashboard size={18} />}>
          Drag a widget by its title bar and resize it from its lower-right corner; it snaps to the
          grid. Remove widgets with their close button, or bring them back with Add widget. Your
          arrangement is saved in this browser.
        </Alert>
      )}
      {error && <ErrorText error={`Dashboard could not refresh: ${error}`} />}
      <Box ref={containerRef} pos="relative" className={editing ? 'pp-grid-editing' : undefined}>
        {!data ? (
          error ? null : (
            <Center h={240}>
              <Loader />
            </Center>
          )
        ) : (
          mounted && (
            <>
              {editing && (
                <GridBackground
                  width={width}
                  cols={COLS[bp]}
                  rowHeight={ROW_HEIGHT}
                  margin={MARGIN}
                  containerPadding={[0, 0]}
                  rows={rows + 4}
                  color="var(--pp-grid-cell)"
                  borderRadius={12}
                  className="pp-grid-bg"
                />
              )}
              <Responsive
                width={width}
                breakpoints={BREAKPOINTS}
                cols={COLS}
                layouts={layouts}
                rowHeight={ROW_HEIGHT}
                margin={MARGIN}
                containerPadding={[0, 0]}
                dragConfig={{
                  enabled: editing,
                  handle: '.pp-drag-handle',
                  cancel: '.pp-no-drag',
                }}
                resizeConfig={{ enabled: editing, handles: ['se'] }}
                onLayoutChange={onLayoutChange}
              >
                {visible.map((id: WidgetId) => {
                  const Widget = WIDGET_COMPONENTS[id];
                  return (
                    <div key={id} data-widget={id}>
                      <Widget
                        ctx={{ data, nav, isAdmin }}
                        editing={editing}
                        onRemove={() => update(hideWidget(prefs, id))}
                      />
                    </div>
                  );
                })}
              </Responsive>
            </>
          )
        )}
      </Box>
    </Stack>
  );
}
