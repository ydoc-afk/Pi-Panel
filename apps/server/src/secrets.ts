import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypts secrets at rest (AES-256-GCM). The key lives in `<dataDir>/secret.key` (mode 0600) and
 * is created on first use, so a database copy alone does not reveal stored API keys.
 */
export class Secrets {
  private key: Buffer | undefined;

  constructor(private readonly dataDir: string) {}

  private getKey(): Buffer {
    if (this.key) return this.key;
    const path = join(this.dataDir, 'secret.key');
    let key: Buffer;
    try {
      key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      mkdirSync(this.dataDir, { recursive: true });
      key = randomBytes(32);
      writeFileSync(path, key.toString('hex'), { mode: 0o600 });
    }
    if (key.length !== 32) throw new Error(`${path} is corrupt (expected 32 bytes of hex)`);
    return (this.key = key);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
      .join(':');
  }

  decrypt(blob: string): string {
    const [version, iv, tag, ct] = blob.split(':');
    // ct is legitimately empty for an empty plaintext, so only a missing part is malformed.
    if (version !== 'v1' || !iv || !tag || ct === undefined)
      throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
