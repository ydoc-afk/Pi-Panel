import { describe, expect, it } from 'vitest';
import { FakeRuntime } from './runtime.js';
import { REA_IMAGE, ReaBuilder, ReaBuildError, cleanReaInput } from './rea-build.js';

const SHA = 'a'.repeat(64);
const URL_OK = 'https://example.com/ghidra_11.zip';

/** Waits until the background build leaves the 'building' state. */
async function settle(builder: ReaBuilder) {
  for (let i = 0; i < 200; i++) {
    const { build } = await builder.status();
    if (build.status !== 'building') return build;
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
      { ghidraUrl: URL_OK, ghidraSha256: `${'g'.repeat(64)}` },
      { ghidraUrl: undefined, ghidraSha256: SHA },
    ];
    for (const input of bad) {
      expect(() => cleanReaInput(input)).toThrow(ReaBuildError);
    }
  });
});

describe('ReaBuilder', () => {
  it('reports the image as missing until a build succeeds', async () => {
    const runtime = new FakeRuntime();
    const builder = new ReaBuilder(runtime);
    expect(await builder.status()).toMatchObject({
      image: REA_IMAGE,
      present: false,
      build: { status: 'idle', log: [] },
    });
  });

  it('builds with the verified Ghidra arguments and keeps the log', async () => {
    const runtime = new FakeRuntime();
    const builder = new ReaBuilder(runtime);
    builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    const build = await settle(builder);

    expect(build.status).toBe('done');
    expect(build.log).toContain('Successfully built fake');
    expect(runtime.builds).toEqual([
      { tag: REA_IMAGE, buildArgs: { GHIDRA_URL: URL_OK, GHIDRA_SHA256: SHA } },
    ]);
    expect((await builder.status()).present).toBe(true);
  });

  it('records a failed build with its error and leaves the image absent', async () => {
    const runtime = new FakeRuntime();
    runtime.buildFailure = 'sha256 mismatch';
    const builder = new ReaBuilder(runtime);
    builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    const build = await settle(builder);

    expect(build).toMatchObject({ status: 'failed', error: 'sha256 mismatch' });
    expect((await builder.status()).present).toBe(false);
  });

  it('refuses a second build while one is running', async () => {
    const builder = new ReaBuilder(new FakeRuntime());
    builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    let thrown: unknown;
    try {
      builder.start({ ghidraUrl: URL_OK, ghidraSha256: SHA });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReaBuildError);
    expect((thrown as ReaBuildError).status).toBe(409);
    await settle(builder);
  });
});
