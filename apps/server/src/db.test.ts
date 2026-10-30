import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';

describe('openDb migrations', () => {
  it('adds provider columns to a sessions table created before providers existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-db-'));
    try {
      const path = join(dir, 'old.db');
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, container_id TEXT, status TEXT, created_at INTEGER);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, status TEXT,
          pi_session_file TEXT, created_at INTEGER);
        INSERT INTO sessions (id, project_id, name, status, created_at) VALUES (1, 1, 'kept', 'idle', 0);
      `);
      old.close();

      const db = openDb(path);
      const cols = (
        db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['provider_id', 'model_id']));
      expect(db.prepare('SELECT name, provider_id FROM sessions').get()).toEqual({
        name: 'kept',
        provider_id: null,
      });
      expect(() => openDb(path)).not.toThrow(); // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
