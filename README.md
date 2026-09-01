# SchemaVC — version control for database schemas

Branch, diff, and merge database schemas **semantically**. Git merges text; two branches that each add a `status` column to `orders` merge cleanly in git and explode at apply time. SchemaVC versions the schema itself: the unit of change is a typed operation (`add_column`, `rename_column`, `retype_column`, …), merges are three-way over those operations with a real conflict model, and a Postgres migration comes out the other end.

**The decision log lives in [decisions.md](decisions.md)** — what was chosen, what was rejected, and why. It's the most useful document in this repo.

## Try it in two minutes

1. Sign up (any email — it only attributes your changes; everyone shares one repository).
2. On **Branches**, click **Load the template** — a realistic e-commerce schema (users, products, orders, order_items with keys, FKs, checks, indexes) lands as a commit on main.
3. Create a branch, e.g. `feature/order-status`. On it: add a `status varchar(20)` column to `orders`, then an index on it. Commit both from the pending tray.
4. Now play the teammate: go to **main** and add a `status text` column to `orders` too. Commit.
5. Back on your branch → **Compare with main**. The same-name add is caught as a conflict *with attribution and consequences spelled out* — pick **Keep your change** and watch the merge commit gain a compensating op that reverses main's column. Merge.
6. The **Deploy** page shows the pending migration SQL (dependency-ordered, one transaction, destructive ops annotated), a preflight you must acknowledge, and a deployed-pointer timeline. Copy the SQL or mark it deployed.

Things worth trying to break: rename a column on one branch while indexing it on another (auto-merges — identity is id-based, not name-based); drop a table one branch, FK to it from another (cross-table conflict); commit from two tabs at once (optimistic 409, your tray survives).

## Running locally

Requirements: Node 20+, a Postgres to point at.

```bash
npm install
createdb schemavc_dev            # the app's own state store
cp .env.example .env.local       # then edit if your Postgres isn't on localhost:5432
npm run dev                      # http://localhost:3000
```

`.env.local`:

| Variable | Required | Purpose |
|---|---|---|
| `APP_DATABASE_URL` | yes | the app's own state (branches, commits, users) — tables are created automatically on first request |
| `JWT_SECRET` | in production | session signing |
| `TARGET_DATABASE_URL` | no | a real database for the **Deploy to target** button; without it, deploys are copy-the-SQL + "Mark as deployed" |

The app store and the target are never the same database: the target belongs to the user and is written only during a deploy, inside one transaction.

## Tests

```bash
npm test                  # engine + unit suites — no database needed, sub-second
npm run test:integration  # + real-Postgres suites (uses schemavc_test / schemavc_test_target on localhost)
```

142 tests. The heart is a **table-driven merge suite**: one row per conflict-taxonomy case — including the cases that must auto-merge — each also run with sides swapped to assert conflict symmetry, and every clean result re-validated and re-applied onto main's real head. Integration tests cover the optimistic-concurrency 409s, the full branch→conflict→resolve→merge→deploy journey, and a real deploy that fails mid-script and must roll back completely.

`GET /api/health/invariant` replays every commit in the live store from the root and verifies each stored snapshot — the persistent-history checksum, callable in production.

## Architecture in one screen

```
src/core/       the engine — pure functions, zero I/O, zero framework imports
  model.ts        schema types, stable ids, the (only) type parser
  apply.ts        the single authoritative way a schema changes
  effects.ts      per-op read/write/delete sets → drives BOTH conflict detection and ordering
  merge.ts        three-way merge: 3 generic rules + post-merge validator + resolutions
  validate.ts     whole-schema consistency (dup names, dangling FKs, PK nullability…)
  order.ts        dependency ordering (topological, stable)
  safety.ts       additive / needs-care / destructive tagging with reasons
  sql.ts          deterministic Postgres DDL out; never SQL in
  invert.ts       compensating ops for "keep your change"

src/server/     thin shell: transactions, auth, optimistic head guards
src/app/        Next.js UI + internal JSON API (not a product surface)
```

Load-bearing rule: everything interesting lives in `src/core` as data-in/data-out functions, so the entire conflict taxonomy is tested without a database, and the browser reuses the exact same `apply()` to preview pending changes before commit.

## Deploying

Built for Vercel + Neon (or any Node host + Postgres):

1. Create a Neon project; take its connection string as `APP_DATABASE_URL`.
2. `vercel` → set env vars `APP_DATABASE_URL`, `JWT_SECRET` (any long random string), optionally `TARGET_DATABASE_URL` (a second Neon database works nicely as a demo target).
3. There is no migration step — the app bootstraps its own tables on first request.
