import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals vendor secrets at rest with AES-256-GCM. Output: "v1:<iv>:<tag>:<data>"
 * (base64). The key comes from INTEGRATIONS_ENCRYPTION_KEY (see config.ts).
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
  }

  seal(values: Record<string, string>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Throws when the key changed or the text was tampered with. */
  open(sealed: string | null | undefined): Record<string, string> {
    if (!sealed) return {};
    const [version, iv, tag, data] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable integration secrets');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(text) as Record<string, string>;
  }
}
