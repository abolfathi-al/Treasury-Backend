# Treasury Backend

Minimal NestJS bootstrap for the authorized SLICE-1 foundation.
The exact governed source is pinned in `canon-revision.json`.

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

Domain endpoints remain blocked until their Canon contracts are resolved. This
scaffold intentionally contains no controller, database, authentication, or
generic application layers.
