# Treasury Backend

NestJS modular monolith through the owner-approved `INC-1C-PARTY-DIRECTORY` increment.
The exact governed source is pinned in `canon-revision.json`.

## Runtime

Requirements:

- Node.js 20 or newer
- PostgreSQL 18
- one same-origin HTTPS frontend

Copy `.env.example` into the deployment's secret/configuration system. Do not
commit real database credentials or cryptographic keys. Argon2 parameters are
explicit deployment inputs: benchmark the target host, select the lowest
profile that meets the security target without exhausting the request budget,
and keep the chosen profile stable across replicas. Encoded Argon2 hashes retain
their parameter version, and successful login rehashes an obsolete profile.
TOTP ciphertext records carry a key version; retain decrypt-only prior versions
in `TOTP_ENCRYPTION_KEYS_JSON` until all rows have been rotated.

```sh
npm install
npm run db:migrate
npm run bootstrap:operator
npm run typecheck
npm test
npm run build
npm start
```

`bootstrap:operator` is local-only and rejects non-TTY input. It takes bootstrap
password, TOTP codes, and the TOTP encryption key through hidden interactive
input; creates the organization, direct Treasury Unit, base Currency, first
administrator, `SYSTEM_ADMIN` role, and organization grant in one advisory-
locked transaction; then displays the single recovery code once.

## Implemented contract

- opaque, digest-at-rest `__Host-treasury_session` sessions;
- password login, RFC 6238 SHA-256 TOTP, current session, logout, and saved-code
  plus current-TOTP password recovery;
- exact-Origin and session-bound Angular XSRF double-submit checks;
- organization, Branch, Treasury Unit, User Reference, Identity Account, and
  Currency foundation operations;
- Method Definition list/create with normalized references/currencies/limits,
  category-specific anchors, tracking requirements, positive per-currency
  limits, and idempotent creation;
- typed organization-scoped Party list/create with normalized multi-role kinds
  and idempotent creation;
- command-bound TOTP step-up for `createIdentityAccount`.

There are no JWTs, generic repositories, CQRS buses, microservices, queues,
caches, or runtime Method activation paths in this increment.
