import { useEffect, useState } from 'react';
import {
  AppShell,
  Burger,
  Button,
  Center,
  Container,
  Group,
  Loader,
  NavLink,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBrandGithub, IconFolder, IconKey, IconLogout, IconPlug } from '@tabler/icons-react';
import { AuthForm } from './AuthForm.js';
import { ColorControls } from './ColorControls.js';
import { GitHubAccount } from './GitHubAccount.js';
import { McpServers } from './McpServers.js';
import { Projects } from './Projects.js';
import { Providers } from './Providers.js';
import { getStatus, logout, type AuthStatus, type User } from './api.js';

type Tab = 'projects' | 'providers' | 'mcp' | 'github';

const TABS: { value: Tab; label: string; icon: typeof IconFolder }[] = [
  { value: 'projects', label: 'Projects', icon: IconFolder },
  { value: 'providers', label: 'Providers', icon: IconKey },
  { value: 'mcp', label: 'MCP', icon: IconPlug },
  { value: 'github', label: 'GitHub', icon: IconBrandGithub },
];

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('projects');
  const [navOpened, nav] = useDisclosure();

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, user: null }));
  }, []);

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
        <Group justify="space-between" mb="md">
          <Title order={1}>Pi-Panel</Title>
          <ColorControls />
        </Group>
        <AuthForm setup={status.setupRequired} onAuthed={authed} />
      </Container>
    );
  }

  const go = (t: Tab) => {
    setTab(t);
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
            <Title order={3}>Pi-Panel</Title>
          </Group>
          <Group gap="md" wrap="nowrap">
            <ColorControls />
            <Text size="sm" c="dimmed" visibleFrom="md">
              {status.user.username}
            </Text>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconLogout size={14} />}
              onClick={() => logout().then(() => setStatus({ setupRequired: false, user: null }))}
            >
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        {TABS.map((t) => (
          <NavLink
            key={t.value}
            label={t.label}
            leftSection={<t.icon size={18} stroke={1.6} />}
            active={tab === t.value}
            onClick={() => go(t.value)}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="lg">
          {tab === 'projects' && <Projects />}
          {tab === 'providers' && <Providers />}
          {tab === 'mcp' && <McpServers />}
          {tab === 'github' && <GitHubAccount />}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
