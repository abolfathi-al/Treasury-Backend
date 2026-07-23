import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';

export const SESSION_COOKIE = '__Host-treasury_session';
export const XSRF_COOKIE = 'XSRF-TOKEN';

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestId(value: string | undefined): string {
  return value && value.length >= 1 && value.length <= 128 ? value : randomUUID();
}

export function commandDigest(scope: string, value: unknown): string {
  const key = Buffer.from(process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 ?? '', 'base64');
  if (key.length < 32) throw new Error('COMMAND_DIGEST_HMAC_KEY_BASE64 is invalid');
  return createHmac('sha256', key)
    .update('treasury-command-digest:v1\0')
    .update(scope)
    .update('\0')
    .update(stableJson(value))
    .digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      cookies[part.trim()] = '';
      continue;
    }
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
    } catch {
      // Malformed percent-encoding is untrusted input; omit that cookie.
    }
  }
  return cookies;
}

export function setSessionCookies(response: Response, sessionToken: string, xsrfToken: string): void {
  response.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; Secure; HttpOnly; SameSite=Strict`);
  response.append('Set-Cookie', `${XSRF_COOKIE}=${encodeURIComponent(xsrfToken)}; Path=/; Secure; SameSite=Strict`);
}

export function setXsrfCookie(response: Response, xsrfToken: string): void {
  response.append('Set-Cookie', `${XSRF_COOKIE}=${encodeURIComponent(xsrfToken)}; Path=/; Secure; SameSite=Strict`);
}

export function clearSessionCookies(response: Response): void {
  response.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  response.append('Set-Cookie', `${XSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
