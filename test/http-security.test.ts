import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ArgumentsHost,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import type { Request, Response } from 'express';

import {
  clearSessionCookies,
  commandDigest,
  digest,
  parseCookies,
  requestId,
  setSessionCookies,
  stableJson,
} from '../src/common/http';
import { csrfValid } from '../src/access-control/auth.guard';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/access-control/auth.service';
import {
  ProblemFilter,
  TreasuryProblem,
} from '../src/common/problem';

function fakeResponse(): { response: Response; cookies: string[] } {
  const cookies: string[] = [];
  return {
    cookies,
    response: {
      append(name: string, value: string) {
        if (name === 'Set-Cookie') cookies.push(value);
        return this;
      },
    } as unknown as Response,
  };
}

test('session exchange emits only strict __Host and Angular XSRF cookies', () => {
  const { response, cookies } = fakeResponse();
  setSessionCookies(response, 'session', 'xsrf');
  assert.match(cookies[0]!, /^__Host-treasury_session=session; Path=\/; Secure; HttpOnly; SameSite=Strict$/u);
  assert.match(cookies[1]!, /^XSRF-TOKEN=xsrf; Path=\/; Secure; SameSite=Strict$/u);
  assert.ok(cookies.every((cookie) => !cookie.includes('Domain=')));
});

test('logout clears both cookies with the same security attributes', () => {
  const { response, cookies } = fakeResponse();
  clearSessionCookies(response);
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) => cookie.includes('Secure') && cookie.includes('SameSite=Strict') && cookie.includes('Max-Age=0')));
});

test('cookie parsing, stable command digesting, and hashing are deterministic', () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
  assert.deepEqual(parseCookies('a=1; XSRF-TOKEN=proof'), { a: '1', 'XSRF-TOKEN': 'proof' });
  assert.deepEqual(parseCookies('__Host-treasury_session=%ZZ; XSRF-TOKEN=%E0%A4%A'), {});
  assert.equal(requestId('valid-request'), 'valid-request');
  assert.match(requestId('x'.repeat(129)), /^[0-9a-f-]{36}$/u);
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  assert.equal(digest('proof'), digest('proof'));
  assert.equal(commandDigest('scope', { b: 2, a: 1 }), commandDigest('scope', { a: 1, b: 2 }));
  assert.notEqual(commandDigest('scope', { secret: 'temporary' }), digest(stableJson({ secret: 'temporary' })));
});

test('recovery HTTP responses are explicit 200 and RFC problem responses use the required media type', async (t) => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
  const service = app.get(AuthService);
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close();
    if ((error as { code?: string }).code === 'EPERM') {
      t.skip('sandbox does not allow loopback listeners');
      return;
    }
    throw error;
  }
  const address = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const invalid = await fetch(`${base}/v1/auth/password-recoveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers.get('content-type') ?? '', /^application\/problem\+json/u);
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await invalid.json() as { code: string }).code,
      'TRS-AUT-006',
    );

    const malformedCookie = await fetch(`${base}/v1/auth/sessions/current`, {
      headers: { Cookie: '__Host-treasury_session=%ZZ', 'X-Request-Id': 'x'.repeat(129) },
    });
    assert.equal(malformedCookie.status, 401);
    assert.match(malformedCookie.headers.get('content-type') ?? '', /^application\/problem\+json/u);
    const malformedCookieBody = await malformedCookie.json() as {
      code: string;
      requestId: string;
    };
    assert.equal(malformedCookieBody.code, 'TRS-AUT-003');
    assert.match(String(malformedCookieBody.requestId), /^[0-9a-f-]{36}$/u);

    for (const [path, body, expectedStatus, expectedCode] of [
      [
        'totp-verifications',
        { challengeId: '', code: '123456' },
        401,
        'TRS-AUT-005',
      ],
      [
        'totp-verifications',
        { challengeId: 'challenge', code: '12345' },
        401,
        'TRS-AUT-002',
      ],
      [
        'password-recoveries',
        {
          login: 'admin',
          newPassword: 'short',
          recoveryCode: 'saved-code',
          totpCode: '123456',
        },
        422,
        'TRS-AUT-007',
      ],
      [
        'password-recoveries',
        {
          login: 'admin',
          newPassword: 'a sufficiently long new password',
          recoveryCode: 'saved-code',
          totpCode: '12345',
        },
        401,
        'TRS-AUT-006',
      ],
    ] as const) {
      const response = await fetch(`${base}/v1/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json() as { code?: string };
      assert.equal(response.status, expectedStatus, JSON.stringify(responseBody));
      assert.equal(responseBody.code, expectedCode);
    }

    service.recoverPassword = async () => {
      throw new TreasuryProblem('TRS-AUT-008', 429, undefined, { retryAfter: 17 });
    };
    const throttled = await fetch(`${base}/v1/auth/password-recoveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: 'admin',
        newPassword: 'a sufficiently long new password',
        recoveryCode: 'saved-code',
        totpCode: '123456',
      }),
    });
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get('retry-after'), '17');
    const throttledBody = await throttled.json() as Record<string, unknown>;
    assert.equal('retryAfter' in throttledBody, false);

    service.recoverPassword = async () => ({
      outcome: 'PASSWORD_RESET',
      replacementRecoveryCode: 'replacement',
    });
    const success = await fetch(`${base}/v1/auth/password-recoveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: 'admin',
        newPassword: 'a sufficiently long new password',
        recoveryCode: 'saved-code',
        totpCode: '123456',
      }),
    });
    assert.equal(success.status, 200);

    const invalidStartPassword = await fetch(`${base}/v1/auth/totp-enrollments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: 'admin',
        currentOrTemporaryPassword: 'a sufficiently long current password',
        newPassword: 'short',
      }),
    });
    assert.equal(invalidStartPassword.status, 422);
    assert.equal(
      (await invalidStartPassword.json() as { code: string }).code,
      'TRS-AUT-007',
    );

    const invalidStartProof = await fetch(`${base}/v1/auth/totp-enrollments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: '',
        currentOrTemporaryPassword: 'short',
        newPassword: 'a sufficiently long replacement password',
      }),
    });
    const invalidStartProofBody = await invalidStartProof.json() as { code?: string };
    assert.equal(invalidStartProof.status, 401, JSON.stringify(invalidStartProofBody));
    assert.equal(
      invalidStartProofBody.code,
      'TRS-AUT-001',
    );

    const invalidEnrollmentId = await fetch(`${base}/v1/auth/totp-enrollment-completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: 'invalid',
        firstCode: '123456',
        secondCode: '654321',
      }),
    });
    assert.equal(invalidEnrollmentId.status, 401);
    assert.equal(
      (await invalidEnrollmentId.json() as { code: string }).code,
      'TRS-AUT-005',
    );

    const invalidEnrollmentCodes = await fetch(`${base}/v1/auth/totp-enrollment-completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: 'a'.repeat(43),
        firstCode: '12345',
        secondCode: '654321',
      }),
    });
    assert.equal(invalidEnrollmentCodes.status, 401);
    assert.equal(
      (await invalidEnrollmentCodes.json() as { code: string }).code,
      'TRS-AUT-002',
    );
  } finally {
    await app.close();
  }
});

test('auth validation failures map only to operation-declared Canon codes', () => {
  assert.deepEqual(
    filteredValidationProblem(
      '/v1/auth/totp-verifications',
      ['challengeId must be longer than or equal to 1 characters'],
    ),
    { status: 401, code: 'TRS-AUT-005' },
  );
  assert.deepEqual(
    filteredValidationProblem(
      '/v1/auth/totp-verifications',
      ['code must match /^[0-9]{6}$/ regular expression'],
    ),
    { status: 401, code: 'TRS-AUT-002' },
  );
  assert.deepEqual(
    filteredValidationProblem(
      '/v1/auth/password-recoveries',
      ['newPassword must be longer than or equal to 15 characters'],
    ),
    { status: 422, code: 'TRS-AUT-007' },
  );
  assert.deepEqual(
    filteredValidationProblem(
      '/v1/auth/password-recoveries',
      ['totpCode must match /^[0-9]{6}$/ regular expression'],
    ),
    { status: 401, code: 'TRS-AUT-006' },
  );
});

test('CSRF requires exact Origin and a cookie/header proof bound to the session', () => {
  const proofDigest = digest('proof');
  assert.equal(
    csrfValid('https://treasury.example', 'https://treasury.example', 'proof', 'proof', proofDigest),
    true,
  );
  assert.equal(
    csrfValid('https://treasury.example', 'https://evil.example', 'proof', 'proof', proofDigest),
    false,
  );
  assert.equal(
    csrfValid('https://treasury.example', 'https://treasury.example', 'proof', 'other', proofDigest),
    false,
  );
});

function filteredValidationProblem(
  path: string,
  messages: string[],
): { status: number; code: string } {
  let status = 0;
  let body: { code?: string } = {};
  const response = {
    setHeader: () => undefined,
    status(value: number) {
      status = value;
      return this;
    },
    type() {
      return this;
    },
    send(value: { code?: string }) {
      body = value;
      return this;
    },
  } as unknown as Response;
  const request = {
    method: 'POST',
    path,
    header: () => undefined,
  } as unknown as Request;
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(
    new BadRequestException({ message: messages }),
    host,
  );
  return { status, code: body.code ?? '' };
}
