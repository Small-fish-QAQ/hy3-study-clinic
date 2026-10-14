import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Windows protects the local encryption key with DPAPI CurrentUser. No secret in argv. */
function dpapi(value: Buffer, operation: 'Protect' | 'Unprotect'): Buffer {
  const script = `Add-Type -AssemblyName System.Security; $data = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${operation}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return Buffer.from(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: value.toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim(),
    'base64',
  );
}

export interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

export class ProviderSecrets {
  constructor(private readonly keyPath: string) {}

  private key(create: boolean): Buffer {
    let stored: Buffer;
    try {
      stored = readFileSync(this.keyPath);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      stored = process.platform === 'win32' ? dpapi(key, 'Protect') : key;
      writeFileSync(this.keyPath, stored, { mode: 0o600, flag: 'wx' });
    }
    if (process.platform !== 'win32') chmodSync(this.keyPath, 0o600);
    const key = process.platform === 'win32' ? dpapi(stored, 'Unprotect') : stored;
    if (key.length !== 32) throw new Error('Invalid local encryption key.');
    return key;
  }

  encrypt(value: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
    return {
      iv: iv.toString('base64'),
      ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }
  decrypt(value: EncryptedSecret): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(false),
      Buffer.from(value.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
