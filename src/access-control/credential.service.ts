import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TreasuryProblem } from '../common/problem';

const scrypt = promisify(scryptCallback);
const ARGON2_PROFILE = {
  type: argon2.argon2id as 2,
  memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 65_536),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
};

export interface EncryptedTotpSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

@Injectable()
export class CredentialService {
  private readonly blockedPasswords = new Set(
    readFileSync(join(process.cwd(), 'config/password-blocklist.txt'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim().normalize('NFC').toLocaleLowerCase('en-US'))
      .filter((line) => line && !line.startsWith('#')),
  );

  normalizeLogin(login: string): string {
    return login.trim().normalize('NFC').toLocaleLowerCase('en-US');
  }

  validatePassword(password: string, context: string[] = []): string {
    const normalized = password.normalize('NFC');
    const length = [...normalized].length;
    const lowered = normalized.toLocaleLowerCase('en-US');
    const contextTokens = context
      .flatMap((item) => item.normalize('NFC').toLocaleLowerCase('en-US').split(/[^a-z0-9\u0600-\u06ff]+/u))
      .filter((item) => item.length >= 4);

    if (length < 15 || length > 128) {
      throw new TreasuryProblem('TRS-AUT-007', 422, 'Password must contain 15 to 128 Unicode code points.');
    }
    if (this.blockedPasswords.has(lowered) || contextTokens.some((token) => lowered.includes(token))) {
      throw new TreasuryProblem('TRS-AUT-007', 422, 'Password is present in the prohibited password blocklist.');
    }
    return normalized;
  }

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_PROFILE);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password.normalize('NFC'));
    } catch {
      return false;
    }
  }

  passwordNeedsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_PROFILE);
  }

  generateTotpSecret(): Buffer {
    return randomBytes(32);
  }

  encryptTotpSecret(secret: Buffer, key: Buffer, keyVersion: number): EncryptedTotpSecret {
    if (key.length !== 32) throw new Error('TOTP encryption key must be 256 bits');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion,
    };
  }

  decryptTotpSecret(encrypted: EncryptedTotpSecret, key: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  runtimeTotpKey(version: number): Buffer {
    const keyringSource = process.env.TOTP_ENCRYPTION_KEYS_JSON;
    let encoded: string | undefined;
    if (keyringSource) {
      const keyring = JSON.parse(keyringSource) as Record<string, string>;
      encoded = keyring[String(version)];
    } else if (Number(process.env.TOTP_KEY_VERSION ?? 1) === version) {
      encoded = process.env.TOTP_ENCRYPTION_KEY_BASE64;
    }
    if (!encoded) throw new Error(`No TOTP encryption key is configured for version ${version}`);
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error(`TOTP encryption key version ${version} is not 256 bits`);
    return key;
  }

  totp(secret: Buffer, counter: number): string {
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha256', secret).update(counterBytes).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return binary.toString().padStart(6, '0');
  }

  verifyTotp(
    secret: Buffer,
    code: string,
    lastAcceptedCounter: number | null,
    now = Date.now(),
  ): number | null {
    const current = Math.floor(now / 30_000);
    for (const counter of [current, current - 1]) {
      if (lastAcceptedCounter !== null && counter <= lastAcceptedCounter) continue;
      const expected = Buffer.from(this.totp(secret, counter));
      const supplied = Buffer.from(code);
      if (supplied.length === expected.length && timingSafeEqual(expected, supplied)) return counter;
    }
    return null;
  }

  generateRecoveryCode(): string {
    return randomBytes(16).toString('base64url');
  }

  async hashRecoveryCode(code: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(code, salt, 32) as Buffer;
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  async verifyRecoveryCode(stored: string | null, code: string): Promise<boolean> {
    if (!stored) return false;
    const [algorithm, saltEncoded, digestEncoded] = stored.split('$');
    if (algorithm !== 'scrypt' || !saltEncoded || !digestEncoded) return false;
    const expected = Buffer.from(digestEncoded, 'base64url');
    const actual = await scrypt(code, Buffer.from(saltEncoded, 'base64url'), expected.length) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  base32(secret: Buffer): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const byte of secret) bits += byte.toString(2).padStart(8, '0');
    let result = '';
    for (let index = 0; index < bits.length; index += 5) {
      result += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
    }
    return result;
  }
}
