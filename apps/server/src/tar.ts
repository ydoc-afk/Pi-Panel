/** Minimal ustar writer, enough to copy a small file tree into a container with Docker's putArchive. */
export interface TarEntry {
  /** Path inside the archive without a leading slash; a trailing slash makes it a directory. */
  path: string;
  content?: Buffer;
  mode?: number;
  uid?: number;
  gid?: number;
}

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  // ustar stores long paths as prefix (<=155) + name (<=100), split on a slash.
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name && Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155)
      return { name, prefix };
  }
  throw new Error(`Path too long for tar: ${path}`);
}

function header(entry: TarEntry, mtime: number): Buffer {
  const isDir = entry.path.endsWith('/');
  const content = entry.content ?? Buffer.alloc(0);
  const { name, prefix } = splitPath(isDir ? entry.path.slice(0, -1) + '/' : entry.path);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100);
  h.write(octal(entry.mode ?? (isDir ? 0o755 : 0o644), 8), 100);
  h.write(octal(entry.uid ?? 0, 8), 108);
  h.write(octal(entry.gid ?? 0, 8), 116);
  h.write(octal(isDir ? 0 : content.length, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write('        ', 148); // checksum placeholder: eight spaces
  h.write(isDir ? '5' : '0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

export function createTar(entries: TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry, mtime));
    const isDir = entry.path.endsWith('/');
    if (!isDir && entry.content && entry.content.length > 0) {
      parts.push(entry.content);
      const pad = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
