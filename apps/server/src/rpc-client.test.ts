import { describe, expect, it } from 'vitest';
import { FakePiProcess } from './fake-pi.js';
import { LineFramer, RpcClient, type PiEvent } from './rpc-client.js';

describe('LineFramer', () => {
  it('splits on LF only and strips CR', () => {
    const f = new LineFramer();
    expect(f.push('{"a":1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(f.push(':3}\n')).toEqual(['{"c":3}']);
  });

  it('does not split on U+2028/U+2029 inside records', () => {
    const f = new LineFramer();
    const line = JSON.stringify({ text: 'a b c' }) + '\n';
    expect(f.push(line)).toEqual([line.trimEnd()]);
  });

  it('reassembles multi-byte characters split across chunks', () => {
    const f = new LineFramer();
    const buf = Buffer.from(JSON.stringify({ t: 'héllo 🙂' }) + '\n');
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) out.push(...f.push(buf.subarray(i, i + 1)));
    expect(JSON.parse(out[0]!)).toEqual({ t: 'héllo 🙂' });
  });
});

describe('RpcClient with the fake pi', () => {
  const setup = (chunkSize?: number) => {
    const proc = new FakePiProcess([], { chunkSize });
    const client = new RpcClient(proc, 500);
    const events: PiEvent[] = [];
    client.onEvent((e) => events.push(e));
    return { proc, client, events };
  };
  const settled = (events: PiEvent[]) => events.some((e) => e.type === 'agent_settled');
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it('correlates responses and streams events, even byte-by-byte', async () => {
    const { client, events } = setup(1);
    const state = await client.request({ type: 'get_state' });
    expect(state.success).toBe(true);
    const res = await client.request({ type: 'prompt', message: 'héllo' });
    expect(res.data).toEqual({ disposition: 'started' });
    await until(() => settled(events));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('agent_start');
    expect(types.at(-1)).toBe('agent_settled');
    const end = events.filter((e) => e.type === 'message_end').at(-1) as unknown as {
      message: { content: { text: string }[] };
    };
    expect(end.message.content[0]?.text).toBe('You said: héllo');
  });

  it('reports unknown commands as failed responses', async () => {
    const { client } = setup();
    const res = await client.request({ type: 'nope' });
    expect(res.success).toBe(false);
  });

  it('rejects pending requests when the process exits', async () => {
    const { proc, client } = setup();
    const closed = new Promise<number | null>((r) => client.onClose((code) => r(code)));
    proc.crash(3);
    expect(await closed).toBe(3);
    await expect(client.request({ type: 'get_state' })).rejects.toThrow(/exited/);
  });
});
