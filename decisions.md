# decisions.md

The problem: **version control for database schemas** — branch, diff, merge. This file records the calls I made, what I seriously considered instead, why I went the way I did, and what I deliberately cut. Ordered roughly by how much each decision shaped everything after it.

---

## 1. Framing: merge *meaning*, not text

Teams already version schemas — as migration files in git. But git merges text, not meaning. Two branches that each add a `status` column to `orders` merge cleanly in git and explode at apply time. One branch renames `user_id → account_id` while another adds an index on `user_id`: git sees no conflict; the database does. So the product I built is **semantic** branch/diff/merge where the unit of change is a schema operation, not a line of SQL.

**Who it's for:** a backend/data engineer on a team where several people change the schema. The job: see what diverged, merge safely, get a migration out the other end, and know what's live.

**The depth bet:** most submissions will do a visual diff and call "apply both sides" a merge. I spent the depth budget on the merge engine — a principled conflict model, a post-merge validator, a resolution flow that records every choice — and kept the UI plain but considered.

## 2. Own an internal model; SQL is only an output

**Decision:** the app owns a plain data structure (tables, columns, constraints, indexes) and generates DDL from it. It never parses SQL in.

**Alternatives considered:**
- *Parse real Postgres DDL* (via `libpg_query`/`pgsql-ast-parser`). Realistic, but the grammar is enormous — parameterised types, inline vs table-level constraints, arbitrary `DEFAULT`/`CHECK` expressions, quoted identifiers, dollar quoting — and every clause is a case to handle or silently drop. It contributes nothing to diff/merge, which is the evaluated problem.
- *LLM-based DDL parsing.* Rejected harder: silent errors (a dropped constraint, an invented column) undermine a tool whose whole pitch is semantic correctness, it makes tests flaky or mocked, and it adds an API key to the evaluator's setup.

**Cut:** DDL import entirely, for v1. The real need it served — "get a realistic schema in fast" — is solved by a one-click e-commerce template instead. Import is listed as future work (parser library, or LLM → JSON validated against the model → validator → human review, never LLM for *generation*).

**Consequence accepted:** `default` values and `check` expressions are opaque strings passed through to DDL verbatim. Parsing SQL expressions is the same rabbit hole in miniature.

## 3. Stable ids on every entity — the rename problem dissolves

**Decision:** every table, column, constraint, and index carries a random 8-hex-char `id` besides its `name`. All references (PK columns, FK targets, index columns) point at ids, never names.

**Why:** a rename is "same id, different name". The merge engine distinguishes *renamed* from *dropped-and-re-added* with zero heuristics — which is exactly the ambiguity that makes snapshot-diffing tools guess, and a wrong guess produces a destructive migration. It also makes "one side renames a column, the other adds an index on it" a *non*-conflict: the index references the id, and the exported DDL uses whatever name the merged snapshot ends up with. There's a table-driven test asserting precisely that case auto-merges.

**Alternative rejected:** name-based identity with rename heuristics (same type + position). Heuristics guess wrong exactly when it matters.

## 4. History: operation log *and* materialised snapshot (hybrid)

**Decision:** every commit stores both the ordered list of typed ops (`add_column`, `rename_column`, `retype_column`, … 13 kinds) and the full schema snapshot after applying them. Ops are the source of truth; the snapshot is derived, written in the same transaction, and **never** updated independently: `commit.snapshot = apply(parent.snapshot, commit.ops)`.

**Alternatives:**
- *Pure snapshots (git-style):* rename detection needs heuristics — see 3.
- *Pure op log (Darcs-style):* every read replays from the root; validating anything means rebuilding state.

**Tradeoff accepted:** ~2× storage per commit. A snapshot is a few KB of JSON; there will be hundreds of commits, not millions. No delta compression.

**The invariant is enforced, not hoped for:** `GET /api/health/invariant` replays every commit in the store from the root and compares against stored snapshots (canonically — Postgres `jsonb` doesn't preserve key order, which bit me in testing). The same check runs in the integration suite.

## 5. Primary keys are a constraint kind, not special ops

The op vocabulary could have grown `set_primary_key`/`drop_primary_key`. Instead a PK is a fourth constraint kind next to `unique`/`check`/`foreign_key`, so adding/dropping one reuses `add_constraint`/`drop_constraint` — the conflict rules and dependency ordering cover it with zero new code. The validator gains exactly two rules: at most one PK per table, and PK columns must be `NOT NULL`.

## 6. Conflict detection: three generic rules over read/write sets, not a case list

**Decision:** every op declares which entity ids it **writes**, **deletes**, and **reads** (an FK reads its target table and columns; `drop_table` deletes every id the table contains). Conflict detection is then three rules over the two sides' ops since the fork:

1. **Write/write** — both sides write the same id → conflict (both renamed/retyped the same column…).
2. **Delete vs anything** — one side deletes an id the other writes *or reads* → conflict (drop table vs add column to it; drop column vs index on it; drop table vs FK pointing at it…).
3. Otherwise → auto-merge.

**Alternative rejected:** a hand-enumerated conflict taxonomy ("if rename and drop then…"). Every case I enumerated while scoping falls out of the three rules, a new op type only needs an `effects()` declaration to participate, and the rules are testable as a table. The same effect sets drive dependency ordering (Kahn's topological sort: creators before readers, readers before deleters), so conflict detection and statement ordering can't drift apart.

**A case the rules deliberately don't flag:** both sides drop the same column. Intents agree — the feature's redundant drop is auto-omitted rather than surfaced as a conflict.

## 7. The post-merge validator — catching what pairwise checks can't

Some problems only exist once both sides are combined: both branches add `orders.status` with different random ids (no rule fires — different ids!), or branch A adds an FK to a table branch B dropped in a way that survived resolution. So after every auto-merge *and after every resolution*, the merged snapshot runs through a validator: unique table/column/object names, FK targets exist, referenced columns exist, PK columns not-null, types on the allowed list. Any failure becomes a **semantic** conflict card with the same resolution flow as a hard conflict.

This is defense in depth: rules catch *intent* collisions, the validator catches *emergent* ones. It also runs on every ordinary commit (you cannot even commit an inconsistent schema) — which is what lets the merge engine assert "both heads validate" as a precondition instead of handling garbage downstream.

**Build note:** `apply()` normally rejects duplicate names outright. The merge pipeline applies candidates with a `allowNameCollisions` flag so the duplicate *lands* in the candidate schema and the validator can report it as a semantic conflict — otherwise the same-name-add case would surface as an internal error instead of a resolvable card.

## 8. Merge mechanics: three-way, feature→main only, always a merge commit

- **Three-way over the stored fork point.** A branch is created only from main's head and records `forked_from`, so there's no LCA algorithm — the third point of the three-way merge is looked up, not computed.
- **Branches merge once, then archive.** Kills rebase, re-merging, branch-from-branch, and pulling main into a branch. "Sync a stale branch" becomes "merge, then branch again". Main's history stays strictly linear — which is what makes "pending deploy = commits after the pointer" trivial later.
- **Every merge writes a merge commit, even when main hasn't moved.** One code path, no fast-forward special case.
- **`M.ops` = the feature's surviving ops + compensating ops.** "Keep your change" against something main did is honest about mechanics: main's history is never rewritten; instead the merge commit contains an inverse op (recreate the dropped table as it stood before the drop, rename back, …) followed by the feature's op. A worked exception: write/write of the same kind (rename vs rename) needs no compensation — the feature's op simply supersedes.
- **Resolutions are recorded on the merge commit** — conflict, rule, explanation, choice, who, when — and shown on the commit page. An audit trail of judgment calls, not just outcomes.

## 9. Stateless merge sessions — determinism instead of server state

**Decision:** there is no "merge session" row. The compare page holds resolution choices client-side; after each Apply the server re-runs the whole merge computation with the accumulated resolutions and returns fresh state (including any *new* semantic conflicts). Submitting the merge re-runs it once more server-side and writes the result.

**What makes this safe:** `merge()` is deterministic — same inputs and resolutions produce byte-identical output, including conflict ids (content hashes over rule + op provenance). So the submit can't disagree with what the user last saw *unless main moved* — and that exact case is caught by optimistic concurrency: the submit carries `expectedMainHead`; if stale, it 409s, the client recomputes, and resolutions whose conflict ids survive are kept while orphaned ones are dropped with a notice.

**Alternative rejected:** a server-side merge-session table. More honest-feeling, but it needs cleanup, invalidation when main moves, and adds nothing determinism doesn't already give. Tradeoff accepted: a hard refresh loses in-progress choices.

## 10. Concurrency: optimistic heads everywhere

Every mutation of a branch head — commit, merge, deploy — carries the head the client believes in, and the write is `UPDATE … WHERE head = $expected`. Zero rows updated → 409 with a human explanation, never a silent overwrite and never a lock held across user think-time. The commit tray survives the 409 client-side and is re-validated against the new head. Deploys are additionally single-flight via a partial unique index (one `pending` row per target). These paths are integration-tested against real Postgres, including the race.

## 11. Safety tags: row data is out of scope, risk to it is not

The brief excludes row data. But every op's *risk to* data on a non-empty database is computable from the schema alone, so each op is tagged **additive** / **needs care** (add `NOT NULL` without default, narrow `varchar(100)→varchar(20)`, cross-family retype, unique constraint…) / **destructive** (drops), with a one-line reason. One classifier feeds three surfaces: the compare view's change list, advisory warnings ("main dropped a column on a table you're touching — merge anyway?"), and the deploy preflight the user must acknowledge. High signal, ~100 lines.

This is also why types are **Postgres-native with real parameters** (`varchar(n)`, `numeric(p,s)`) rather than a generic `string`/`int` layer: narrowing detection needs the numbers, and the exported DDL stays concrete. Cut: every other dialect, arrays, enums, custom types.

## 12. Migration SQL: deterministic, ordered, transactional

One op → one statement, generated by walking the op list against the evolving snapshot (so a rename earlier in the script changes the names later statements use — there's a test for that). Statements are dependency-ordered by the same effect sets as the merge. The script is wrapped in `BEGIN…COMMIT`, and the op vocabulary deliberately contains no non-transactional DDL (`CREATE INDEX CONCURRENTLY` is cut), so the wrapper is always sound. Destructive/needs-care statements carry `-- comments` with reasons.

**Definition choice:** the deploy page's SQL is always "everything from the deployed pointer to main's head", not "SQL for the last merge". Deploy is about the state of a database, not the shape of one PR.

## 13. Deploy: full flow now, real connection optional

A `deployed` pointer on main's linear history marks what's live; everything after is pending. Two implementations behind one interface: with no `TARGET_DATABASE_URL`, the deploy view shows the SQL and offers **Mark as deployed** (you ran it yourself); with one, **Deploy to target** runs the script statement-by-statement in a single transaction on the user's database — commit on success, full rollback on any error, with the exact failing statement and Postgres error recorded and shown. The pointer moves only after success.

**Tested for real:** the integration suite deploys to a real Postgres, then forces a mid-script failure (retype over incompatible data) and asserts the rollback left earlier statements unapplied and the pointer unmoved.

**Cuts, deliberately:** down-migrations/rollback (you cannot invert `drop column` without the data — the per-deploy transaction is the honest safety net), multiple targets (modelled as a table, shipped as one row), drift detection via `information_schema`, deploy-to-intermediate-commit. **Known limitation, written down rather than hidden:** a crash between the target's commit and the app's pointer update leaves a deployed-but-unrecorded state; fixing it needs two-phase commit, out of scope for v1.

## 14. Two databases, two roles

The app's own state (users, branches, commits, deployments) lives in its own Postgres, never in the target. Mixing them would pollute any future introspection of the target and make "the app dropped my table" a possible bug class. The app store's schema is created with idempotent DDL at first touch instead of a migration tool — one less moving part for a 5-day build whose own schema is small and append-only. (Yes, a schema-versioning tool hand-rolling its own schema setup is funny. The alternative was running a second migration system inside the first.)

## 15. Interface scope: UI only, auth minimal

- **No public API.** The frontend talks to internal JSON routes; that surface is not designed, documented, or stabilized. Removes a whole product surface to secure and document; nothing in the evaluation needs it.
- **Auth exists to attribute changes to people** — conflict cards saying *"Priya, 2 days ago"* are core UX, and that requires accounts. Email + password (bcrypt), JWT in an httpOnly SameSite=Lax cookie, 24h, re-login on expiry. **Everyone shares one repository**; no roles, no invitations, no password reset, no OAuth. None of it affects the evaluated problem.
- **Commit granularity:** every UI action = one op; ops pool in a pending tray, committed as one batch with a message. No staging, no partial commits, no editing ops in the tray (discard and redo). Staging is git's most-confused UX surface and adds no evaluation value.

## 16. Stack: TypeScript everywhere, Next.js, Vercel + Neon

**Decision:** one language end to end. The engine is a pure, dependency-free TS package (`src/core`) — no I/O, no framework imports — under table-driven vitest suites that run in milliseconds. Next.js provides the internal API and UI in one deployable; Vercel + Neon deploy it with near-zero ops.

**Why it beat the alternatives** (FastAPI+React, Go+React): the deciding factor wasn't language preference but **reuse of the engine across the boundary** — the branch editor runs the same `apply()` in the browser to preview pending changes and pre-validate commits, which a Python or Go engine can't offer without a second implementation. Plus one deploy target instead of two.

## 17. Testing philosophy: the taxonomy is data

The merge suite is a table of `(fork, main ops, feature ops) → expected conflicts` — one row per taxonomy case, including the ones that must *auto-merge* (rename + index-on-old-name). Every case is additionally run **with sides swapped**, asserting the conflict set is symmetric — a cheap property test that caught real ordering assumptions. Every clean merge result must pass the validator and must `apply()` onto main's real head. Integration tests cover what unit tests can't: concurrency 409s, the full journey against Postgres, and deploy rollback. 142 tests total; the engine suite runs with no database.

**A bug the invariants caught during development, kept here for honesty:** an early version of the history-walk SQL returned the *entire* history as "pending" when the deployed pointer already equalled main's head — the recursion guard didn't handle the anchor-equals-stop case. The integration test on "mark as deployed" caught it the first time it ran.

## 18. What I'd do next (in order)

1. **Sandbox target database** bundled with the hosted app + reset button, so an evaluator can run a real deploy end to end without owning a Postgres.
2. **DDL import** behind the validator + review screen (see 2).
3. **"Write my own" conflict resolution** — a SQL/op editor as a third choice, validated by the same post-merge validator that already re-checks every resolution.
4. Drift detection (introspect the target, diff against the snapshot at `deployed`).
5. Merge preview on the branch page ("if you merged now: N auto, M conflicts").
