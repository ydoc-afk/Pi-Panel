import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from './runtime.js';
import { REA_IMAGE, ReaBuilder, ReaBuildError, cleanReaInput } from './rea-build.js';

const SHA = 'a'.repeat(64);
const URL_OK = 'https://example.com/ghidra_11.zip';

/** A fetch that answers the link check with the given status and size. */
const linkAnswers = (status: number, length?: number) =>
  vi.fn(
    async () =>
      new Response(null, {
        status,
        headers: length === undefined ? {} : { 'content-length': String(length) },
      }),
  ) as unknown as typeof fetch;

/** Waits until the background build leaves its running states. */
async function settle(builder: ReaBuilder) {
  for (let i = 0; i < 200; i++) {
    const { build } = await builder.status();
    if (build.status !== 'building' && build.status !== 'checking') return build;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('build did not finish');
}

describe('cleanReaInput', () => {
  it('accepts an https URL and a 64-character checksum, normalised', () => {
    expect(cleanReaInput({ ghidraUrl: ` ${URL_OK} `, ghidraSha256: SHA.toUpperCase() })).toEqual({
      ghidraUrl: URL_OK,
      ghidraSha256: SHA,
    });
  });

  it('refuses plain http, other schemes and malformed checksums', () => {
    const bad = [
      { ghidraUrl: 'http://example.com/g.zip', ghidraSha256: SHA },
      { ghidraUrl: 'file:///etc/passwd', ghidraSha256: SHA },
      { ghidraUrl: 'not a url', ghidraSha256: SHA },
      { ghidraUrl: URL_OK, ghidraSha256: 'abc' },
      { ghidraUrl: URL_OK, ghidraSha256: 'g'.repeat(64) },
      { ghidraUrl: undefined, ghidraSha256: SHA },
    ];
    for (const input of bad) {
      expect(() => cleanReaInput(input)).toThrow(ReaBuildError);
    }
  });
});

describe('ReaBuilder', () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the image as missing until a build succeeds', async () => {
    const builder = new ReaBuilder(new FakeRuntime());
    expect(await builder.status()).toMatchObject({
      image: REA_IMAGE,
      present: false,
      build: { status: 'idle', log: [] },
    });
  });

  it('checks the link, builds with the verified Ghidra arguments, and logs each stage', async () => {
    const runtime = new FakeRuntime();
    const builder = new ReaBuilder(runtime, { fetch: linkAnswers(200, 570_000_000) });
    await builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    const build = await settle(builder);

    expect(build.status).toBe('done');
    expect(build.log.join('\n')).toMatch(/Link OK, the download is 570 MB/);
    expect(build.log.at(-1)).toMatch(/Image built$/);
    expect(build.log.every((l) => /^\[\d\d:\d\d:\d\d\] /.test(l))).toBe(true);
    expect(runtime.builds).toEqual([
      { tag: REA_IMAGE, buildArgs: { GHIDRA_URL: URL_OK, GHIDRA_SHA256: SHA } },
    ]);
    expect((await builder.status()).present).toBe(true);
  });

  it('stops before any build when the link does not answer, and says why', async () => {
    const runtime = new FakeRuntime();
    const builder = new ReaBuilder(runtime, { fetch: linkAnswers(404) });
    await expect(builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('HTTP 404'),
    });
    expect(runtime.builds).toEqual([]);
    expect((await builder.status()).build).toMatchObject({ status: 'failed' });
  });

  it('gives a plain reason when the link cannot be reached at all', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const builder = new ReaBuilder(new FakeRuntime(), { fetch: offline });
    await expect(builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA })).rejects.toThrow(
      'Could not reach the Ghidra link',
    );
  });

  it('records a failed build, adds a checksum hint, and keeps the reason', async () => {
    const runtime = new FakeRuntime();
    runtime.buildFailure = 'sha256sum: WARNING: 1 computed checksum did NOT match';
    const builder = new ReaBuilder(runtime, { fetch: linkAnswers(200) });
    await builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    const build = await settle(builder);

    expect(build.status).toBe('failed');
    expect(build.error).toBe(runtime.buildFailure);
    expect(build.hint).toMatch(/does not match the file at this link/);
    expect(build.log.join('\n')).toMatch(/Hint: The checksum/);
    expect((await builder.status()).present).toBe(false);
  });

  it('refuses a second build while one is running', async () => {
    const runtime = new FakeRuntime();
    let release!: () => void;
    runtime.buildGate = new Promise<void>((resolve) => (release = resolve));
    const builder = new ReaBuilder(runtime, { fetch: linkAnswers(200) });
    await builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });

    await expect(builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA })).rejects.toMatchObject({
      status: 409,
    });
    release();
    await settle(builder);
  });

  it('writes a timestamped log file per build and serves the latest one', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pp-rea-'));
    const builder = new ReaBuilder(new FakeRuntime(), { dataDir, fetch: linkAnswers(200) });
    expect(builder.latestLog()).toBeNull();
    await builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    await settle(builder);

    const text = builder.latestLog();
    expect(text).toMatch(/\[\d\d:\d\d:\d\d\] Checking the Ghidra link/);
    expect(text).toMatch(/Image built/);
    const [file] = readdirSync(join(dataDir, 'logs'));
    expect(readFileSync(join(dataDir, 'logs', file!), 'utf8')).toBe(text);
  });
});
