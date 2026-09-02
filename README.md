# SchemaVC — version control for database schemas

Branch, diff, and merge database schemas **semantically**. Git merges text; two branches that each add a `status` column to `orders` merge cleanly in git and explode at apply time. SchemaVC versions the schema itself: the unit of change is a typed operation (`add_column`, `rename_column`, `retype_column`, …), merges are three-way over those operations with a real conflict model, and a Postgres migration comes out the other end.

**The decision log lives in [decisions.md](decisions.md)** — what was chosen, what was rejected, and why. It's the most useful document in this repo.

## Try it in two minutes

1. Sign up (any email — it only attributes your changes; everyone shares one repository).
2. On **Branches**, click **Load the template** — a realistic e-commerce schema (users, products, orders, order_items with keys, FKs, checks, indexes) lands as a commit on main.
3. Create a branch, e.g. `feature/order-status`. On it: add a `status varchar(20)` column to `orders`, then an index on it. Commit both from the pending tray.
4. Now play the teammate: create a second branch, add a `status text` column to `orders` there, and merge it (main itself only changes through merges).
5. Back on your first branch → **Compare with main**. The same-name add is caught as a conflict *with attribution and consequences spelled out* — pick **Keep your change** and watch the merge commit gain a compensating op that reverses main's column. Merge.
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

163 tests. The heart is a **table-driven merge suite**: one row per conflict-taxonomy case — including the cases that must auto-merge — each also run with sides swapped to assert conflict symmetry, and every clean result re-validated and re-applied onto main's real head. Integration tests cover the optimistic-concurrency 409s, the full branch→conflict→resolve→merge→deploy journey, and a real deploy that fails mid-script and must roll back completely.

`GET /api/health/invariant` replays every commit in the live store from the root and verifies each stored snapshot — the persistent-history checksum, callable in production.

## Architecture

Three layers, one load-bearing rule: **everything interesting is a pure library.** `src/core` is plain data-in/data-out functions — no I/O, no database, no framework imports. The other two layers are thin shells around it.

```
┌─ src/app ────────────────────────────────────────────────────┐
│  Next.js UI (login · branches · editor · compare · deploy)   │
│  + internal JSON API routes (cookie-authed, not a product    │
│  surface). Pages render state; routes parse/validate input   │
│  and call one service function each.                         │
└──────────────────────────────┬───────────────────────────────┘
┌─ src/server ─────────────────┴───────────────────────────────┐
│  Decides WHEN things happen: auth, transactions, optimistic  │
│  head guards, persistence, the deploy target connection.     │
└──────────────────────────────┬───────────────────────────────┘
┌─ src/core ───────────────────┴───────────────────────────────┐
│  Decides WHAT happens: apply · merge · validate · order ·    │
│  safety · sql. Pure, deterministic, tested without a DB.     │
└──────────────────────────────────────────────────────────────┘
```

The rule buys two things: the entire conflict taxonomy is tested in milliseconds with no database, and the browser bundles the same engine to preview pending changes exactly as the server will judge them.

### The engine — `src/core`

| File | Job |
|---|---|
| `model.ts` | The schema as plain data: tables, columns, constraints, indexes — each with a stable random id besides its name (a rename is "same id, new name", so no rename-detection heuristics exist anywhere). Contains the codebase's only string parser, for `varchar(n)` / `numeric(p,s)`. |
| `ops.ts` | The 13 typed operations (`add_column`, `rename_table`, `drop_constraint`, …) — the unit of change everywhere. |
| `apply.ts` | The single authoritative way a schema changes: applies an op list, rejecting unknown ids, duplicate names, bad types. Used by the server on every commit and by the browser for live preview. |
| `effects.ts` | Declares, per op, which ids it reads / writes / deletes. This one declaration drives *both* conflict detection and SQL ordering, so they can never disagree. |
| `merge.ts` | The three-way merge: three generic conflict rules over the two sides' effect sets, then resolutions, then re-validation of the combined result. Deterministic — same inputs, byte-identical output. |
| `validate.ts` | Whole-schema consistency: duplicate names, dangling FK/index references, PK columns must be NOT NULL… Runs on every commit and after every merge/resolution. |
| `order.ts` | Dependency-orders an op list (topological sort over the effect sets) so, e.g., an index is dropped before its column. |
| `safety.ts` | Tags every op additive / needs-care / destructive with a one-line reason. Feeds the change list, merge advisories, and the deploy preflight. |
| `sql.ts` | Ops → deterministic Postgres DDL (one op, one statement) and whole-schema `CREATE TABLE` export. SQL only ever comes *out*; nothing parses SQL in. |
| `invert.ts` | Builds the compensating op for "keep your change" resolutions (recreate the dropped table as it stood, rename back…). |
| `defaults.ts`, `describe.ts`, `ids.ts` | The bare-word DEFAULT lint, human-readable op descriptions, id generation. |

### The shell — `src/server` and `src/app`

- `services.ts` — one function per use-case (commit, compare, merge, deploy…): load state, call the engine, persist inside a transaction. This is the only place engine and database meet.
- `store.ts` / `db.ts` — row mapping and the commit-chain queries; schema bootstraps itself idempotently on first request (no migration tool).
- `auth.ts`, `opschema.ts`, `http.ts` — JWT cookies, zod validation of incoming ops, structured errors.
- `target.ts` — the deploy target behind one interface: a real Postgres (statement-by-statement in one transaction, full rollback on failure) or a no-op "you ran it yourself" mode.
- `src/app/api/*` — one route per endpoint; parse, authenticate, call a service, serialize.
- `src/app/*` — the five screens; `branches/[id]/editor.tsx` (the schema editor + pending tray) and `branches/[id]/compare/page.tsx` (conflict cards + resolution loop) are the two big ones.

### What happens when…

- **…you commit:** the editor turned each of your edits into a typed op held in the tray. Commit POSTs them with the branch head you were looking at; the server re-applies them onto the real head (`apply`), re-checks the result (`validate`), and in one transaction writes the commit — ops *and* resulting snapshot — advancing the head only if nobody moved it first (otherwise a 409, and your tray survives).
- **…you compare / merge:** the server loads the fork-point snapshot and both sides' ops since it, and runs `merge()` — nothing is written. Your resolution choices live client-side; every "Apply" re-runs the same computation with them. Submitting re-runs it once more and writes a merge commit recording the surviving ops, any compensating ops, and every conflict + choice + author.
- **…you deploy:** pending ops (deployed pointer → main's head) are dependency-ordered, turned into SQL, and run in a single transaction on the target database. Any failure rolls everything back, leaves the pointer unmoved, and records the exact failing statement and Postgres error.

### Where to start reading

`model.ts` (the data) → `apply.ts` (how it changes) → `effects.ts` + `merge.ts` (the heart) → `core/__tests__/merge.test.ts` (the taxonomy as a readable table) → `server/services.ts` (how it's wired) → `app/branches/[id]/compare/page.tsx` (how it's shown).

## Deploying

Built for Vercel + Neon (or any Node host + Postgres):

1. Create a Neon project; take its connection string as `APP_DATABASE_URL`.
2. `vercel` → set env vars `APP_DATABASE_URL`, `JWT_SECRET` (any long random string), optionally `TARGET_DATABASE_URL` (a second Neon database works nicely as a demo target).
3. There is no migration step — the app bootstraps its own tables on first request.
