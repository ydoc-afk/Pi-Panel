import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from './router.js';

describe('router', () => {
  it('parses tabs, projects and sessions', () => {
    expect(parseRoute('')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('#/dashboard')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('#/mcp')).toEqual({ tab: 'mcp' });
    expect(parseRoute('#/projects/3')).toEqual({ tab: 'projects', projectId: 3 });
    expect(parseRoute('#/projects/3/sessions/7')).toEqual({
      tab: 'projects',
      projectId: 3,
      sessionId: 7,
    });
  });

  it('falls back to the dashboard for an unknown page', () => {
    expect(parseRoute('#/nope')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('#/projects/abc')).toEqual({ tab: 'projects' });
    expect(parseRoute('#/providers/3')).toEqual({ tab: 'providers' });
  });

  it('round-trips', () => {
    for (const h of [
      '#/dashboard',
      '#/projects',
      '#/users',
      '#/projects/1',
      '#/projects/1/sessions/2',
    ]) {
      expect(routeHash(parseRoute(h))).toBe(h);
    }
  });
});
