import { useEffect, useState } from 'react';

export type Tab = 'projects' | 'providers' | 'mcp' | 'github' | 'users';

export interface Route {
  tab: Tab;
  projectId?: number;
  sessionId?: number;
}

const TABS: Tab[] = ['projects', 'providers', 'mcp', 'github', 'users'];

/** #/projects/3/sessions/7 → { tab: 'projects', projectId: 3, sessionId: 7 }. Unknown → projects. */
export function parseRoute(hash: string): Route {
  const [tab, id, sub, sid] = hash.replace(/^#\/?/, '').split('/');
  if (!TABS.includes(tab as Tab)) return { tab: 'projects' };
  if (tab !== 'projects' || !/^\d+$/.test(id ?? '')) return { tab: tab as Tab };
  const route: Route = { tab: 'projects', projectId: Number(id) };
  if (sub === 'sessions' && /^\d+$/.test(sid ?? '')) route.sessionId = Number(sid);
  return route;
}

export function routeHash(r: Route): string {
  let h = `#/${r.tab}`;
  if (r.tab === 'projects' && r.projectId !== undefined) {
    h += `/${r.projectId}`;
    if (r.sessionId !== undefined) h += `/sessions/${r.sessionId}`;
  }
  return h;
}

export function navigate(r: Route): void {
  const h = routeHash(r);
  if (location.hash !== h) location.hash = h;
}

/** The current route, kept in sync with the address bar (so refresh and Back work). */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
