import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS asset
import { sanitizePayload, sanitizeSchema } from '../assets/schema-sanitizer.js';

describe('schema sanitizer', () => {
  it('inlines $ref, flattens unions and drops regexes', () => {
    const out = sanitizeSchema({
      type: 'object',
      $defs: { Op: { type: 'string', enum: ['a', 'b'], pattern: '^x' } },
      required: ['op', 'ghost'],
      properties: {
        op: { $ref: '#/$defs/Op' },
        n: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
        t: { type: ['string', 'null'], format: 'uri' },
      },
    });
    expect(out).toEqual({
      type: 'object',
      required: ['op'],
      properties: {
        op: { type: 'string', enum: ['a', 'b'] },
        n: { type: 'integer', minimum: 1 },
        t: { type: 'string' },
      },
    });
  });

  it('survives recursive refs and non-object roots', () => {
    const rec = { type: 'object', properties: { next: { $ref: '#' } } };
    expect(sanitizeSchema(rec).properties.next).toEqual({});
    expect(sanitizeSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} });
  });

  it('rewrites chat-completions tool payloads and leaves others alone', () => {
    const payload = {
      model: 'm',
      tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: { a: { pattern: 'x' } } } } }],
    };
    expect(sanitizePayload(payload).tools[0].function.parameters.properties.a).toEqual({});
    expect(sanitizePayload({ model: 'm' })).toEqual({ model: 'm' });
  });
});
