import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demuxDockerLogs, toHostPath } from './docker-runtime.js';
import { createTar } from './tar.js';

describe('createTar', () => {
  const extract = (tar: Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-tar-'));
    execFileSync('tar', ['-xf', '-', '-C', dir], { input: tar });
    return dir;
  };

  it('produces an archive that GNU tar can list and extract, with modes and content', () => {
    const big = Buffer.alloc(1500, 'x');
    const tar = createTar([
      { path: 'lab/', uid: 1000, gid: 1000 },
      { path: 'lab/a.txt', content: Buffer.from('hello'), uid: 1000, gid: 1000 },
      { path: 'lab/run.sh', content: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { path: 'lab/big.bin', content: big },
      { path: 'lab/empty', content: Buffer.alloc(0) },
    ]);
    expect(tar.length % 512).toBe(0);
    const listing = execFileSync('tar', ['-tvf', '-'], { input: tar }).toString();
    expect(listing).toContain('lab/a.txt');
    expect(listing).toMatch(/1000\/1000\s+5 .*lab\/a\.txt/);
    const dir = extract(tar);
    try {
      expect(readFileSync(join(dir, 'lab/a.txt'), 'utf8')).toBe('hello');
      expect(readFileSync(join(dir, 'lab/big.bin')).equals(big)).toBe(true);
      expect(statSync(join(dir, 'lab/run.sh')).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir, 'lab/empty')).size).toBe(0);
      expect(statSync(join(dir, 'lab')).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores long paths using the ustar prefix field', () => {
    const long = `lab/pkg/${'d'.repeat(60)}/${'e'.repeat(60)}/file-with-a-long-name.txt`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(100);
    const dir = extract(createTar([{ path: long, content: Buffer.from('ok') }]));
    try {
      expect(readFileSync(join(dir, long), 'utf8')).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths that cannot be represented', () => {
    expect(() => createTar([{ path: 'x'.repeat(300) }])).toThrow(/too long/);
  });

  it('writes nothing outside the target directory for plain relative entries', () => {
    const dir = extract(createTar([{ path: 'a/b.txt', content: Buffer.from('1') }]));
    try {
      expect(existsSync(join(dir, 'a/b.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demuxDockerLogs', () => {
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };

  it('separates stdout and stderr frames', () => {
    const buf = Buffer.concat([frame(1, 'out1 '), frame(2, 'err1'), frame(1, 'out2')]);
    expect(demuxDockerLogs(buf)).toEqual({ stdout: 'out1 out2', stderr: 'err1' });
  });

  it('tolerates an empty stream and a truncated final frame', () => {
    expect(demuxDockerLogs(Buffer.alloc(0))).toEqual({ stdout: '', stderr: '' });
    const whole = frame(1, 'complete');
    const cut = Buffer.concat([whole, frame(1, 'truncated').subarray(0, 12)]);
    expect(demuxDockerLogs(cut).stdout).toBe('completetrun');
  });
});

describe('toHostPath', () => {
  it('maps paths under the data dir to the host data dir', () => {
    expect(toHostPath('/data/workspaces/1', '/data', '/srv/pi/data')).toBe(
      '/srv/pi/data/workspaces/1',
    );
    expect(toHostPath('/data/agents/2', '/data/', '/srv/pi/data/')).toBe('/srv/pi/data/agents/2');
    expect(toHostPath('/data', '/data', '/srv/pi/data')).toBe('/srv/pi/data');
  });

  it('leaves other paths alone and does nothing without a host dir', () => {
    expect(toHostPath('/data/workspaces/1', '/data', undefined)).toBe('/data/workspaces/1');
    expect(toHostPath('/other/x', '/data', '/srv/pi/data')).toBe('/other/x');
    // a sibling that merely shares the prefix is not inside the data dir
    expect(toHostPath('/database/x', '/data', '/srv/pi/data')).toBe('/database/x');
  });
});
