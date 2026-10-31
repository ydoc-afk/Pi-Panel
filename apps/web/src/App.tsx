import { useEffect, useState } from 'react';
import {
  AppShell,
  Burger,
  Avatar,
  Badge,
  Center,
  Container,
  Group,
  Loader,
  Menu,
  NavLink,
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
  IconInfoCircle,
  IconKey,
  IconLock,
  IconLogout,
  IconPlug,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';
import { AccountDialogs, type AccountDialog } from './AccountDialogs.js';
import { AuthForm } from './AuthForm.js';
import { ColorControls } from './ColorControls.js';
import { GitHubAccount } from './GitHubAccount.js';
import { McpServers } from './McpServers.js';
import { Projects } from './Projects.js';
import { Providers } from './Providers.js';
import { Users } from './Users.js';
import { getStatus, listAccounts, logout, type AuthStatus, type User } from './api.js';
import { navigate, useRoute, type Tab } from './router.js';
import { Tip } from './ui.js';

const TABS: {
  value: Tab;
  label: string;
  hint: string;
  icon: typeof IconFolder;
  adminOnly?: boolean;
}[] = [
  { value: 'projects', label: 'Projects', hint: 'Workspaces and agent sessions', icon: IconFolder },
  {
    value: 'providers',
    label: 'Providers',
    hint: 'Model providers and API keys',
    icon: IconKey,
    adminOnly: true,
  },
  {
    value: 'mcp',
    label: 'MCP',
    hint: 'Tool servers the agent can use',
    icon: IconPlug,
    adminOnly: true,
  },
  {
    value: 'github',
    label: 'GitHub',
    hint: 'Account used to clone and push',
    icon: IconBrandGithub,
    adminOnly: true,
  },
  {
    value: 'users',
    label: 'Users',
    hint: 'Approve or remove accounts',
    icon: IconUsers,
    adminOnly: true,
  },
];

function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <ThemeIcon
        variant="gradient"
        gradient={{ from: 'teal', to: 'cyan' }}
        size={size === 'lg' ? 40 : 30}
      >
        <IconTerminal2 size={size === 'lg' ? 24 : 18} />
      </ThemeIcon>
      <Stack gap={0}>
        <Title order={size === 'lg' ? 2 : 4} lh={1.1}>
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
  const route = useRoute();
  const [dialog, setDialog] = useState<AccountDialog>(null);
  const [navOpened, nav] = useDisclosure();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, user: null }));
  }, []);

  const isAdmin = status?.user?.role === 'admin';
  // A member who follows a link to an admin page lands on Projects instead.
  const tab: Tab = TABS.some((t) => t.value === route.tab && (isAdmin || !t.adminOnly))
    ? route.tab
    : 'projects';

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
      <Container size="xs" py="xl">
        <Group justify="space-between" mb="xl">
          <Brand size="lg" />
          <ColorControls />
        </Group>
        <AuthForm setup={status.setupRequired} onAuthed={authed} />
      </Container>
    );
  }

  const go = (t: Tab) => {
    navigate({ tab: t });
    nav.close();
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 200, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={navOpened} onClick={nav.toggle} hiddenFrom="sm" size="sm" />
            <Brand />
          </Group>
          <Group gap="md" wrap="nowrap">
            <ColorControls />
            <Menu position="bottom-end" width={200}>
              <Menu.Target>
                {/* Mantine's Tooltip passes the menu's click handler and ref through; the Tip
                    wrapper's <span> does not, which left this menu impossible to open. */}
                <Tooltip label="Account" openDelay={350} withArrow>
                  <UnstyledButton aria-label="Account menu">
                    <Avatar size="sm" color="initials" name={status.user.username} />
                  </UnstyledButton>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {status.user.username} · {status.user.role}
                </Menu.Label>
                <Menu.Item
                  leftSection={<IconLock size={14} />}
                  onClick={() => setDialog('password')}
                >
                  Change password
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconInfoCircle size={14} />}
                  onClick={() => setDialog('about')}
                >
                  About
                </Menu.Item>
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

      <AppShell.Navbar p="xs">
        {TABS.filter((t) => isAdmin || !t.adminOnly).map((t) => (
          <Tip key={t.value} label={t.hint}>
            <NavLink
              label={t.label}
              w="100%"
              leftSection={<t.icon size={18} stroke={1.6} />}
              rightSection={
                t.value === 'users' && pending > 0 ? (
                  <Badge size="sm" circle color="orange">
                    {pending}
                  </Badge>
                ) : null
              }
              active={tab === t.value}
              onClick={() => go(t.value)}
            />
          </Tip>
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="lg">
          {tab === 'projects' && (
            <Projects projectId={route.projectId} sessionId={route.sessionId} />
          )}
          {tab === 'providers' && <Providers />}
          {tab === 'mcp' && <McpServers />}
          {tab === 'github' && <GitHubAccount />}
          {tab === 'users' && isAdmin && <Users onChange={setPending} />}
        </Container>
      </AppShell.Main>
      <AccountDialogs open={dialog} onClose={() => setDialog(null)} />
    </AppShell>
  );
}
