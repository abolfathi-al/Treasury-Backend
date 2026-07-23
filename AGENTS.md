# Enterprise Treasury Backend agent contract

This Git repository contains the NestJS backend. Frontend work belongs to the
sibling `../Treasury-Frontend/` repository and must use its own branch, commits,
push, tests, review, and PR. Never mix frontend and backend changes in one
commit or PR.

## Semantic authority

- Treasury meaning comes from `../Treasury-Canon/canon-v4/`. Start with
  `canon.yaml` and `00-governance/authority.yaml`, then load the selected
  delivery slice and its complete context bundle.
- Do not create runtime code while Canon implementation authorization is
  `NONE`.
- A missing or conflicting financial, authorization, lifecycle, integration,
  retention, or runtime rule requires a governed Canon Change Pack.

## Architecture

- Build one NestJS deployable backed by one PostgreSQL database.
- `app.module.ts` composes; Canon owners map to feature modules.
- Controllers validate transport. Services own authorization, business rules,
  transaction boundaries, idempotency, and audit. Repositories contain SQL only.
- One module is the sole writer of its tables. Cross-module calls use explicitly
  exported concrete services, not another module's repository or schema.
- Drizzle provides query types; reviewed committed SQL is migration authority.
- Keep each mutation in one short transaction. Do not perform HTTP or RabbitMQ
  calls inside a database transaction.
- Prefer database constraints, row locks, and optimistic versions. Use
  `SERIALIZABLE` only for a proven predicate race and retry the whole transaction
  after SQLSTATE `40001`.
- Add no generic repository, speculative layer, shared DTO package, CQRS
  framework, GraphQL, cache, microservice, or Kubernetes boundary without a
  current Canon obligation.

## Verification

Use only package scripts committed by the authorized scaffold. Every
non-trivial change must include the smallest relevant tests plus contract,
authorization-denial, transaction, and concurrency checks required by its
delivery packet.
