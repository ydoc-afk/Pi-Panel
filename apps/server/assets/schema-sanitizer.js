// pi extension written to every project's agent dir. llama.cpp (and other OpenAI-compatible servers)
// compile each tool's JSON schema into a grammar and answer 400 "failed to parse grammar" when the
// schema uses $ref, unions, regexes and the like. This rewrites tool schemas in the outgoing request
// into the plain subset those servers accept. It never touches what the MCP server itself receives.

const MAX_DEPTH = 12;
const DROP = new Set([
  '$schema', '$id', '$defs', 'definitions', '$comment', 'pattern', 'patternProperties', 'format',
  'default', 'examples', 'not', 'if', 'then', 'else', 'contentEncoding', 'contentMediaType',
  'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'dependencies',
  'dependentSchemas', 'dependentRequired', 'readOnly', 'writeOnly', 'deprecated', 'title',
]);

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return undefined;
  }
  return node;
}

function clean(node, root, depth, seen) {
  if (node === true || node === undefined || node === null || typeof node !== 'object') return {};
  if (Array.isArray(node)) return {};
  if (depth > MAX_DEPTH) return {};
  let src = node;
  if (typeof src.$ref === 'string') {
    if (seen.includes(src.$ref)) return {};
    const target = resolveRef(src.$ref, root);
    if (!target) return {};
    return clean({ ...target, ...omit(src, '$ref') }, root, depth + 1, [...seen, src.$ref]);
  }
  // Unions: keep the first non-null branch (a single const/enum list is merged instead).
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(src[key])) {
      const branches = src[key].filter((b) => b && b.type !== 'null');
      src = { ...(branches[0] ?? {}), ...omit(src, key) };
    }
  }
  if (Array.isArray(src.allOf)) {
    let merged = omit(src, 'allOf');
    for (const part of src.allOf) {
      const p = typeof part?.$ref === 'string' ? (resolveRef(part.$ref, root) ?? {}) : (part ?? {});
      merged = {
        ...merged,
        ...p,
        properties: { ...(merged.properties ?? {}), ...(p.properties ?? {}) },
        required: [...new Set([...(merged.required ?? []), ...(p.required ?? [])])],
      };
    }
    src = merged;
  }
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP.has(k) || k === 'oneOf' || k === 'anyOf' || k === 'allOf' || k === '$ref') continue;
    if (k === 'type') {
      out.type = Array.isArray(v) ? (v.find((t) => t !== 'null') ?? 'string') : v;
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([name, sub]) => [name, clean(sub, root, depth + 1, seen)]),
      );
    } else if (k === 'items') {
      out.items = clean(Array.isArray(v) ? v[0] : v, root, depth + 1, seen);
    } else if (k === 'additionalProperties') {
      if (typeof v === 'boolean') out.additionalProperties = v;
    } else if (k === 'required') {
      if (Array.isArray(v)) out.required = v.filter((r) => typeof r === 'string');
    } else if (k === 'enum' || k === 'const') {
      if (k === 'enum' ? Array.isArray(v) : true) out[k] = v;
    } else if (['description', 'minItems', 'maxItems', 'minimum', 'maximum'].includes(k)) {
      out[k] = v;
    }
  }
  if (!out.type) out.type = out.properties ? 'object' : out.items ? 'array' : undefined;
  if (out.type === undefined) delete out.type;
  if (out.properties && Array.isArray(out.required)) {
    out.required = out.required.filter((r) => r in out.properties);
    if (!out.required.length) delete out.required;
  }
  return out;
}

function omit(obj, key) {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}

export function sanitizeSchema(schema) {
  const out = clean(schema, schema, 0, []);
  if (out.type !== 'object') return { type: 'object', properties: {} };
  if (!out.properties) out.properties = {};
  return out;
}

/** Rewrites tools[].function.parameters (chat completions) and tools[].parameters (responses). */
export function sanitizePayload(payload) {
  if (!payload || !Array.isArray(payload.tools)) return payload;
  const tools = payload.tools.map((tool) => {
    if (tool?.function?.parameters) {
      return { ...tool, function: { ...tool.function, parameters: sanitizeSchema(tool.function.parameters) } };
    }
    if (tool?.parameters) return { ...tool, parameters: sanitizeSchema(tool.parameters) };
    return tool;
  });
  return { ...payload, tools };
}

export default function (pi) {
  pi.on('before_provider_request', (event) => sanitizePayload(event.payload));
}
