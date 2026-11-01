import { useEffect, useState } from 'react';
import {
  AppShell,
  Burger,
  Avatar,
  Badge,
  Box,
  Center,
  Container,
  Group,
  Loader,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBrandGithub,
  IconFolder,
  IconKey,
  IconLayoutDashboard,
  IconLogout,
  IconPlug,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';
import { AuthForm } from './AuthForm.js';
import { ColorControls } from './ColorControls.js';
import { Dashboard } from './dashboard/Dashboard.js';
import type { DashboardNav } from './dashboard/widgets.js';
import { GitHubAccount } from './GitHubAccount.js';
import { McpServers } from './McpServers.js';
import { Projects } from './Projects.js';
import { Providers } from './Providers.js';
import { Users } from './Users.js';
import { getStatus, listAccounts, logout, type AuthStatus, type User } from './api.js';

type Tab = 'dashboard' | 'projects' | 'providers' | 'mcp' | 'github' | 'users';

const SECTIONS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'admin', label: 'Administration' },
] as const;

const TABS: {
  value: Tab;
  label: string;
  hint: string;
  icon: typeof IconFolder;
  adminOnly?: boolean;
  section: 'workspace' | 'admin';
}[] = [
  {
    value: 'dashboard',
    label: 'Dashboard',
    hint: 'Activity and health at a glance',
    icon: IconLayoutDashboard,
    section: 'workspace',
  },
  {
    value: 'projects',
    label: 'Projects',
    hint: 'Workspaces and agent sessions',
    icon: IconFolder,
    section: 'workspace',
  },
  {
    value: 'providers',
    label: 'Providers',
    hint: 'Model providers and API keys',
    icon: IconKey,
    adminOnly: true,
    section: 'admin',
  },
  {
    value: 'mcp',
    label: 'MCP',
    hint: 'Tool servers the agent can use',
    icon: IconPlug,
    adminOnly: true,
    section: 'admin',
  },
  {
    value: 'github',
    label: 'GitHub',
    hint: 'Account used to clone and push',
    icon: IconBrandGithub,
    adminOnly: true,
    section: 'admin',
  },
  {
    value: 'users',
    label: 'Users',
    hint: 'Approve or remove accounts',
    icon: IconUsers,
    adminOnly: true,
    section: 'admin',
  },
];

function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <ThemeIcon
        variant="gradient"
        gradient={{ from: 'var(--mantine-primary-color-filled)', to: 'cyan', deg: 135 }}
        size={size === 'lg' ? 44 : 32}
        radius="md"
      >
        <IconTerminal2 size={size === 'lg' ? 26 : 19} stroke={1.8} />
      </ThemeIcon>
      <Stack gap={0}>
        <Title order={size === 'lg' ? 2 : 4} lh={1.1} style={{ letterSpacing: '-0.02em' }}>
          Pi-Panel
        </Title>
        {size === 'lg' && (
          <Text size="xs" c="dimmed">
            Self-hosted agent workspaces
          </Text>
        )}
      </Stack>
    </Group>
  );
}

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  // A project (and session) to open when switching to the Projects tab from the dashboard.
  const [focus, setFocus] = useState<{ projectId: number; sessionId?: number; n: number } | null>(
    null,
  );
  const [navOpened, nav] = useDisclosure();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, user: null }));
  }, []);

  const isAdmin = status?.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    listAccounts()
      .then((r) => setPending(r.filter((x) => x.status === 'pending').length))
      .catch(() => {});
  }, [isAdmin]);

  const authed = (user: User) => setStatus({ setupRequired: false, user });

  if (!status) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (!status.user) {
    return (
      <Box className="pp-auth-bg">
        <Group justify="flex-end" p="md">
          <ColorControls />
        </Group>
        <Container size={440} pb="xl" pt={{ base: 0, sm: 'xl' }}>
          <Stack gap="xl">
            <Center>
              <Brand size="lg" />
            </Center>
            <AuthForm setup={status.setupRequired} onAuthed={authed} />
          </Stack>
        </Container>
      </Box>
    );
  }

  const go = (t: Tab) => {
    setTab(t);
    setFocus(null);
    nav.close();
  };

  const dashboardNav: DashboardNav = {
    openProject: (projectId, sessionId) => {
      setFocus((f) => ({ projectId, sessionId, n: (f?.n ?? 0) + 1 }));
      setTab('projects');
    },
    goTo: (t) => go(t),
  };

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 236, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
      padding={{ base: 'md', md: 'xl' }}
    >
      <AppShell.Header className="pp-header">
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={navOpened} onClick={nav.toggle} hiddenFrom="sm" size="sm" />
            <Brand />
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ColorControls />
            <Menu position="bottom-end" width={220} radius="md" shadow="md">
              <Menu.Target>
                {/* Mantine's Tooltip passes the menu's click handler and ref through; the Tip
                    wrapper's <span> does not, which left this menu impossible to open. */}
                <Tooltip label="Account" openDelay={350} withArrow>
                  <UnstyledButton aria-label="Account menu">
                    <Avatar size={34} radius="md" color="initials" name={status.user.username} />
                  </UnstyledButton>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Group gap="sm" px="sm" py={8} wrap="nowrap">
                  <Avatar size={36} radius="md" color="initials" name={status.user.username} />
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600} truncate>
                      {status.user.username}
                    </Text>
                    <Text size="xs" c="dimmed" tt="capitalize">
                      {status.user.role}
                    </Text>
                  </Stack>
                </Group>
                <Menu.Divider />
                <Menu.Item
                  leftSection={<IconLogout size={14} />}
                  onClick={() =>
                    logout().then(() => setStatus({ setupRequired: false, user: null }))
                  }
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          {SECTIONS.map((section) => {
            const items = TABS.filter((t) => t.section === section.id && (isAdmin || !t.adminOnly));
            if (items.length === 0) return null;
            return (
              <Box key={section.id} mb={4}>
                <div className="pp-nav-section">{section.label}</div>
                {items.map((t) => (
                  <Tooltip
                    key={t.value}
                    label={t.hint}
                    position="right"
                    openDelay={500}
                    events={{ hover: true, focus: false, touch: false }}
                  >
                    <NavLink
                      label={t.label}
                      fw={500}
                      leftSection={<t.icon size={18} stroke={1.6} />}
                      rightSection={
                        t.value === 'users' && pending > 0 ? (
                          <Badge size="sm" circle color="orange">
                            {pending}
                          </Badge>
                        ) : null
                      }
                      active={tab === t.value}
                      aria-current={tab === t.value ? 'page' : undefined}
                      onClick={() => go(t.value)}
                    />
                  </Tooltip>
                ))}
              </Box>
            );
          })}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className="pp-main">
        <Container size="xl" px={0}>
          {tab === 'dashboard' && (
            <Dashboard userId={status.user.id} isAdmin={isAdmin} nav={dashboardNav} />
          )}
          {tab === 'projects' && (
            <Projects
              key={focus ? `focus-${focus.n}` : 'list'}
              focus={focus ? { projectId: focus.projectId, sessionId: focus.sessionId } : undefined}
            />
          )}
          {tab === 'providers' && <Providers />}
          {tab === 'mcp' && <McpServers />}
          {tab === 'github' && <GitHubAccount />}
          {tab === 'users' && isAdmin && <Users onChange={setPending} />}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
