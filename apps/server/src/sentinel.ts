/**
 * Extracts the JSON object printed between two sentinel lines by a harness that ran in a container.
 * The text comes from code that ran there, so only the last well-formed, size-bounded object is used.
 */
export function parseSentinelReport(
  stdout: string,
  begin: string,
  end: string,
  maxBytes = 512 * 1024,
): Record<string, unknown> | null {
  const endAt = stdout.lastIndexOf(end);
  const beginAt = endAt < 0 ? -1 : stdout.lastIndexOf(begin, endAt);
  if (beginAt < 0 || endAt < 0) return null;
  const body = stdout.slice(beginAt + begin.length, endAt).trim();
  if (body.length > maxBytes) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
