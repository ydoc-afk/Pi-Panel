import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Secrets } from './secrets.js';

describe('Secrets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pp-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips and never repeats a ciphertext', () => {
    const s = new Secrets(dir);
    const a = s.encrypt('sk-test-123');
    expect(a).not.toContain('sk-test-123');
    expect(s.decrypt(a)).toBe('sk-test-123');
    expect(s.encrypt('sk-test-123')).not.toBe(a);
  });

  it('round-trips an empty string', () => {
    const s = new Secrets(dir);
    expect(s.decrypt(s.encrypt(''))).toBe('');
  });

  it('creates a 0600 key file once and reuses it across instances', () => {
    const blob = new Secrets(dir).encrypt('hello');
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(new Secrets(dir).decrypt(blob)).toBe('hello');
  });

  it('rejects tampered ciphertext and a different key', () => {
    const s = new Secrets(dir);
    const parts = s.encrypt('hello').split(':');
    parts[3] = Buffer.from('tampered-data').toString('base64');
    expect(() => s.decrypt(parts.join(':'))).toThrow();
    const other = mkdtempSync(join(tmpdir(), 'pp-secrets-'));
    try {
      expect(() => new Secrets(other).decrypt(s.encrypt('hello'))).toThrow();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt key file', () => {
    writeFileSync(join(dir, 'secret.key'), 'abcd');
    expect(() => new Secrets(dir).encrypt('x')).toThrow(/corrupt/);
  });
});
