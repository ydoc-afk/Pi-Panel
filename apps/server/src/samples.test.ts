import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { cleanSampleName } from './samples.js';
import { FakeRuntime } from './runtime.js';

function multipartBody(filename: string, content: Buffer | string) {
  const boundary = `----pp${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function setup(
  limits: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pp-samples-'));
  const app = buildApp({
    db: openDb(':memory:'),
    runtime: new FakeRuntime(),
    dataDir,
    samples: limits,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = res.cookies.find((x) => x.name === 'pp_session')!;
  const headers = { cookie: `pp_session=${c.value}` };
  const project = (
    await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'p' } })
  ).json().project;
  const dir = join(dataDir, 'samples', String(project.id));
  const upload = (filename: string, content: Buffer | string, projectId = project.id) => {
    const { payload, contentType } = multipartBody(filename, content);
    return app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/samples`,
      headers: { ...headers, 'content-type': contentType },
      payload,
    });
  };
  const list = async () =>
    (await app.inject({ url: `/api/projects/${project.id}/samples`, headers })).json().files;
  return { app, dataDir, headers, project, dir, upload, list };
}

describe('cleanSampleName', () => {
  it.each([
    ['sample.exe', 'sample.exe'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\evil.dll', 'evil.dll'],
    ['.hidden', 'hidden'],
    ['...dots', 'dots'],
    ['a b  c.bin', 'a b c.bin'],
    ['we!rd*na?me.bin', 'we_rd_na_me.bin'],
    ['x'.repeat(300), 'x'.repeat(120)],
  ])('turns %j into %j', (raw, expected) => expect(cleanSampleName(raw)).toBe(expected));

  it.each(['', '   ', '...', '/', '../', undefined, 42])('rejects %j', (raw) =>
    expect(() => cleanSampleName(raw)).toThrow(),
  );
});

describe('samples', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await t.app.close();
    rmSync(t.dataDir, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    expect((await t.app.inject({ url: `/api/projects/${t.project.id}/samples` })).statusCode).toBe(
      401,
    );
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${t.project.id}/samples` }))
        .statusCode,
    ).toBe(401);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/projects/${t.project.id}/samples/x` }))
        .statusCode,
    ).toBe(401);
  });

  it('stores an upload read-only for others and lists it', async () => {
    const content = Buffer.from([0, 1, 2, 3, 255, 254]);
    const res = await t.upload('sample.bin', content);
    expect(res.statusCode).toBe(201);
    expect(res.json().file).toMatchObject({ name: 'sample.bin', size: 6 });
    expect(readFileSync(join(t.dir, 'sample.bin')).equals(content)).toBe(true);
    expect(statSync(join(t.dir, 'sample.bin')).mode & 0o777).toBe(0o644);
    expect((await t.list()).map((f: { name: string }) => f.name)).toEqual(['sample.bin']);
  });

  it('keeps only a safe file name and never writes outside the samples folder', async () => {
    expect((await t.upload('../../../tmp/escape.txt', 'x')).json().file.name).toBe('escape.txt');
    expect((await t.upload('a\\b\\evil.dll', 'x')).json().file.name).toBe('evil.dll');
    expect((await t.upload('.bashrc', 'x')).json().file.name).toBe('bashrc');
    expect(readdirSync(t.dir).sort()).toEqual(['bashrc', 'escape.txt', 'evil.dll']);
    expect(existsSync(join(t.dataDir, '..', 'escape.txt'))).toBe(false);
    expect((await t.upload('...', 'x')).statusCode).toBe(400);
  });

  it('refuses duplicates, including two uploads of one name at the same time', async () => {
    expect((await t.upload('dup.bin', 'one')).statusCode).toBe(201);
    expect((await t.upload('dup.bin', 'two')).statusCode).toBe(409);
    expect(readFileSync(join(t.dir, 'dup.bin'), 'utf8')).toBe('one');
    const [a, b] = await Promise.all([
      t.upload('race.bin', 'a'.repeat(1000)),
      t.upload('race.bin', 'b'.repeat(1000)),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(readdirSync(t.dir).filter((n) => n.startsWith('.upload-'))).toEqual([]);
  });

  it('rejects requests that are not a multipart file, and unknown projects', async () => {
    const plain = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${t.project.id}/samples`,
      headers: t.headers,
      payload: { not: 'a file' },
    });
    expect(plain.statusCode).toBe(400);
    expect((await t.upload('x.bin', 'x', 999)).statusCode).toBe(404);
    expect(
      (await t.app.inject({ url: '/api/projects/999/samples', headers: t.headers })).statusCode,
    ).toBe(404);
  });

  it('deletes only plain files that exist in the folder', async () => {
    await t.upload('gone.bin', 'x');
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/api/projects/${t.project.id}/samples/gone.bin`,
          headers: t.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(existsSync(join(t.dir, 'gone.bin'))).toBe(false);
    for (const name of ['gone.bin', 'nope', '..%2F..%2Fetc%2Fpasswd', '.upload-x', 'a%2Fb']) {
      const res = await t.app.inject({
        method: 'DELETE',
        url: `/api/projects/${t.project.id}/samples/${name}`,
        headers: t.headers,
      });
      expect([400, 404], name).toContain(res.statusCode);
    }
  });

  it('does not follow or list symlinks and directories planted in the folder', async () => {
    await t.upload('real.bin', 'x');
    mkdirSync(join(t.dir, 'subdir'));
    writeFileSync(join(t.dataDir, 'outside.txt'), 'secret');
    symlinkSync(join(t.dataDir, 'outside.txt'), join(t.dir, 'link.txt'));
    expect((await t.list()).map((f: { name: string }) => f.name)).toEqual(['real.bin']);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/projects/${t.project.id}/samples/link.txt`,
      headers: t.headers,
    });
    expect(del.statusCode).toBe(404);
    expect(existsSync(join(t.dataDir, 'outside.txt'))).toBe(true);
  });
});

describe('sample limits', () => {
  it('rejects a file over the per-file limit and leaves nothing behind', async () => {
    const t = await setup({ maxFileBytes: 1000 });
    try {
      expect((await t.upload('ok.bin', 'x'.repeat(900))).statusCode).toBe(201);
      const big = await t.upload('big.bin', 'x'.repeat(5000));
      expect(big.statusCode).toBe(413);
      expect(readdirSync(t.dir)).toEqual(['ok.bin']);
    } finally {
      await t.app.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });

  it('enforces the per-project total and file count', async () => {
    const t = await setup({ maxTotalBytes: 2000, maxFiles: 3 });
    try {
      expect((await t.upload('a.bin', 'x'.repeat(1500))).statusCode).toBe(201);
      expect((await t.upload('b.bin', 'x'.repeat(1500))).statusCode).toBe(413);
      expect((await t.upload('c.bin', 'x'.repeat(400))).statusCode).toBe(201);
      expect((await t.upload('d.bin', 'x'.repeat(200))).statusCode).toBe(413); // only 100 bytes of quota left
      expect(readdirSync(t.dir).sort()).toEqual(['a.bin', 'c.bin']);
    } finally {
      await t.app.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });

  it('caps how many files a project can hold', async () => {
    const t = await setup({ maxFiles: 2 });
    try {
      for (const n of ['1', '2']) expect((await t.upload(`${n}.bin`, 'x')).statusCode).toBe(201);
      expect((await t.upload('3.bin', 'x')).statusCode).toBe(413);
    } finally {
      await t.app.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});
