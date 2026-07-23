import { createInterface } from 'node:readline/promises';

import { Pool } from 'pg';

import { CredentialService } from '../src/access-control/credential.service';

const bootstrapPermissions = [
  'access-control.view',
  'access-grant.manage',
  'auth.logout',
  'bank-account.manage',
  'bank-account.view',
  'bank-branch.manage',
  'bank-branch.view',
  'bank-type.manage',
  'bank-type.view',
  'bank.manage',
  'bank.view',
  'cashbox.manage',
  'cashbox.view',
  'cheque-book.manage',
  'identity-account.manage',
  'master-data.manage',
  'master-data.view',
  'party.manage',
  'party.view',
  'payment-gateway.manage',
  'payment-gateway.view',
  'pos-terminal.manage',
  'pos-terminal.view',
  'print-template.manage',
  'print-template.view',
  'role.manage',
] as const;

async function bootstrap(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Bootstrap requires a protected interactive TTY.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const answers = await readPublicInputs();
  const credentials = new CredentialService();
  const normalizedLogin = credentials.normalizeLogin(answers.login);
  const password = credentials.validatePassword(
    await readSecret('Administrator password: '),
    [answers.organizationCode, answers.organizationName, answers.adminName, normalizedLogin],
  );
  const passwordConfirmation = await readSecret('Confirm administrator password: ');
  if (password !== passwordConfirmation.normalize('NFC')) throw new Error('Passwords do not match.');

  const encryptionKeyEncoded = await readSecret('TOTP encryption key (32 bytes, base64): ');
  const encryptionKey = Buffer.from(encryptionKeyEncoded, 'base64');
  if (encryptionKey.length !== 32) throw new Error('TOTP encryption key must decode to exactly 32 bytes.');

  const totpSecret = credentials.generateTotpSecret();
  process.stdout.write('\nEnroll this TOTP material now; it will not be shown again.\n');
  process.stdout.write(`Algorithm: SHA256, digits: 6, period: 30, secret: ${credentials.base32(totpSecret)}\n`);
  const firstCounter = await requireTotp(credentials, totpSecret, null, 'First TOTP code: ');
  const secondCounter = await requireTotp(
    credentials,
    totpSecret,
    firstCounter,
    'Next consecutive TOTP code: ',
    firstCounter + 1,
  );

  const passwordHash = await credentials.hashPassword(password);
  const recoveryCode = credentials.generateRecoveryCode();
  const recoveryHash = await credentials.hashRecoveryCode(recoveryCode);
  const encryptedTotp = credentials.encryptTotpSecret(
    totpSecret,
    encryptionKey,
    answers.totpKeyVersion,
  );

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('treasury:first-administrator-bootstrap:v1'))`);
    const state = await client.query<{ organizations: string; users: string; identities: string }>(`
      SELECT
        (SELECT count(*) FROM organizations)::text AS organizations,
        (SELECT count(*) FROM user_refs)::text AS users,
        (SELECT count(*) FROM identity_accounts)::text AS identities
    `);
    const counts = state.rows[0]!;
    if (counts.organizations !== '0' || counts.users !== '0' || counts.identities !== '0') {
      throw new Error('TRS-AUT-011: bootstrap is permanently unavailable after any organization, user, or identity exists.');
    }

    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [
      answers.organizationCode,
      answers.organizationName,
      answers.timezone,
      answers.currencyCode,
    ]);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, english_name, symbol, decimal_places, base_currency
      ) VALUES ($1,$2,$3,$4,$5,$6,true)
    `, [
      organizationId,
      answers.currencyCode,
      answers.currencyName,
      answers.currencyEnglishName || null,
      answers.currencySymbol || null,
      answers.decimalPlaces,
    ]);
    await client.query(`
      INSERT INTO treasury_units (organization_id, code, name, default_currency)
      VALUES ($1,$2,$3,$4)
    `, [
      organizationId,
      answers.unitCode,
      answers.unitName,
      answers.currencyCode,
    ]);
    const user = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1,$2,$3) RETURNING id
    `, [organizationId, answers.subjectKey, answers.adminName]);
    const userId = user.rows[0]!.id;
    const account = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (
        user_ref_id, normalized_login, password_hash,
        totp_ciphertext, totp_iv, totp_auth_tag, totp_key_version,
        totp_last_counter, recovery_code_hash, privileged
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      RETURNING id
    `, [
      userId,
      normalizedLogin,
      passwordHash,
      encryptedTotp.ciphertext,
      encryptedTotp.iv,
      encryptedTotp.authTag,
      encryptedTotp.keyVersion,
      secondCounter,
      recoveryHash,
    ]);
    const role = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1, 'SYSTEM_ADMIN', 'System Administrator') RETURNING id
    `, [organizationId]);
    const roleId = role.rows[0]!.id;
    for (const permission of bootstrapPermissions) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
        [roleId, permission],
      );
    }
    await client.query(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_type, scope_id
      ) VALUES ($1,$2,$3,'ORGANIZATION',$1)
    `, [organizationId, userId, roleId]);
    await client.query(`
      INSERT INTO security_audit_events (
        organization_id, identity_account_id, request_id, event_type, outcome, details
      ) VALUES ($1,$2,$3,'FIRST_ADMINISTRATOR_BOOTSTRAPPED','SUCCEEDED',$4)
    `, [
      organizationId,
      account.rows[0]!.id,
      `bootstrap-${Date.now()}`,
      { organizationCode: answers.organizationCode, subjectKey: answers.subjectKey },
    ]);
    await client.query('COMMIT');

    process.stdout.write('\nBootstrap committed. Save this recovery code now; it will not be shown again:\n');
    process.stdout.write(`${recoveryCode}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function readPublicInputs() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const organizationCode = required(await prompt.question('Organization code: ')).toUpperCase();
    const organizationName = required(await prompt.question('Organization legal name: '));
    const timezone = required(await prompt.question('IANA timezone: '));
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    const currencyCode = required(await prompt.question('Base currency code: ')).toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/u.test(currencyCode)) throw new Error('Invalid currency code.');
    const currencyName = required(await prompt.question('Base currency name: '));
    const currencyEnglishName = await prompt.question('Base currency English name (optional): ');
    const currencySymbol = await prompt.question('Base currency symbol (optional): ');
    const decimalPlaces = Number(await prompt.question('Base currency decimal places (0-8): '));
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 8) {
      throw new Error('Invalid decimal places.');
    }
    const unitCode = required(await prompt.question('Direct Treasury Unit code: '));
    const unitName = required(await prompt.question('Direct Treasury Unit name: '));
    const subjectKey = required(await prompt.question('Administrator subject key: '));
    const adminName = required(await prompt.question('Administrator display name: '));
    const login = required(await prompt.question('Administrator login: '));
    const totpKeyVersion = Number(await prompt.question('TOTP encryption key version: '));
    if (!Number.isInteger(totpKeyVersion) || totpKeyVersion < 1) throw new Error('Invalid key version.');
    return {
      organizationCode,
      organizationName,
      timezone,
      currencyCode,
      currencyName,
      currencyEnglishName,
      currencySymbol,
      decimalPlaces,
      unitCode,
      unitName,
      subjectKey,
      adminName,
      login,
      totpKeyVersion,
    };
  } finally {
    prompt.close();
  }
}

async function readSecret(label: string): Promise<string> {
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (character: string) => {
      if (character === '\u0003') {
        cleanup();
        reject(new Error('Bootstrap cancelled.'));
      } else if (character === '\r' || character === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (character === '\u007f') {
        value = value.slice(0, -1);
      } else if (character >= ' ') {
        value += character;
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

async function requireTotp(
  credentials: CredentialService,
  secret: Buffer,
  previous: number | null,
  label: string,
  exactCounter?: number,
): Promise<number> {
  const code = await readSecret(label);
  const counter = credentials.verifyTotp(secret, code, previous);
  if (counter === null || (exactCounter !== undefined && counter !== exactCounter)) {
    throw new Error('TOTP enrollment requires two valid consecutive counters.');
  }
  return counter;
}

function required(value: string): string {
  const normalized = value.trim().normalize('NFC');
  if (!normalized) throw new Error('A required value was empty.');
  return normalized;
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
