# Dependabot automation for node-deluge-rpc

## Goal

Make Dependabot's weekly updates actually landable: PRs that pass CI on their own,
with breaking majors isolated from routine bumps. Decide separately whether routine
updates should auto-merge.

## Environment / context

- Repo: `cinderblock/node-deluge-rpc` (public), default branch `master`, no branch protection.
- Package manager: **Bun** 1.3.0, text lockfile `bun.lock` (`lockfileVersion: 1`).
- CI: `.github/workflows/ci.yml` — `bun install --frozen-lockfile`, then lint / test / build.
- Publish: `.github/workflows/publish.yml` (uses `actions/setup-node`, npm provenance).
- Repo settings at time of writing: `allow_auto_merge: false`, `delete_branch_on_merge: false`.

## Findings / gotchas

### The lockfile failure had a one-line cause, not a tooling gap

`.github/dependabot.yml` declared `package-ecosystem: npm`. **Bun is its own Dependabot
ecosystem, `bun`** — it is not folded into `npm_and_yarn` from the config's point of view.
The npm updater looks for `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`, finds none,
edits `package.json` and stops. `bun.lock` is left untouched, so CI dies at step one:

```
error: lockfile had changes, but lockfile is frozen
```

PR #17's diff is literally one file (`package.json`) — the signature of this bug. Every npm
Dependabot PR on this repo would have failed the same way; #14/#15 only passed because they
were `github-actions` bumps with no lockfile involved.

**Dead end not taken:** a `workflow_run`-triggered workflow that regenerates `bun.lock` and
pushes it back to the Dependabot branch. This was drafted before the root cause was found.
It is strictly worse — it needs `contents: write`, and pushes made with `GITHUB_TOKEN` do
**not** re-trigger workflows, so the PR would sit permanently red even after being fixed.
Fixing the ecosystem name removes the need entirely. Do not resurrect this.

### Requirements and caveats for `package-ecosystem: bun`

- Requires Bun >= 1.1.39 and the **text** `bun.lock`; the legacy binary `bun.lockb` is
  unsupported. This repo satisfies both.
- Docs list `bun` as generally available (no `enable-beta-ecosystems` needed). Some older
  reports claim the flag was required; if Dependabot rejects the config or silently skips,
  add `enable-beta-ecosystems: true` at the top level as a fallback.
- **Known upstream bug:** `bun.lock` is still not updated correctly in repos using npm
  _workspaces_ (dependabot-core#14223, open). This repo has no workspaces, so it is unaffected.

### Trade-off accepted: no automatic security-fix PRs

Per GitHub's supported-ecosystems table, `bun` supports version updates but **not** security
updates. Dependabot _alerts_ still fire (those come from the dependency graph, not the
updater) — only the automatic "here's a PR that fixes CVE-x" is unavailable. With 5 runtime
deps on a weekly version-update cadence this is a small loss, and the alternative (staying on
`npm` for security PRs) means a permanently red CI on every routine update. Historic PRs #2
(acorn) and #4 (y18n) were security updates from the old npm config, so this is a real,
if minor, regression. Revisit if `bun` gains security-update support.

### Grouping: one major poisoned the whole batch

The old config grouped `*` with no `update-types` filter, so PR #17 bundled four majors:

| Package          | Bump           | Breaking here?                                                                                                                                                                                                                               |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pako`           | 1.0.11 → 3.0.1 | **Yes** — default export removed; `import pako from 'pako'` at `src/DelugeRPC.ts:8` and `src/DelugeRPC.test.ts:5`, 5 call sites. Also `legacyHash` now defaults to `false`, changing binary output — material for Deluge wire compatibility. |
| `snakecase-keys` | 3.1.0 → 9.0.2  | Likely — 6 majors of drift, used at `src/DelugeRPC.ts:7`                                                                                                                                                                                     |
| `typescript`     | 6.0.3 → 7.0.2  | Possibly                                                                                                                                                                                                                                     |
| `@types/pako`    | 1.0.1 → 3.0.0  | Follows `pako`                                                                                                                                                                                                                               |

Splitting the group so only `minor`/`patch` are batched means majors arrive as individual,
reviewable PRs and never block routine maintenance.

### pako 1 → 3 migration: smaller than it looked

Done on branch `pako-3`. Two findings worth keeping:

- **`@types/pako` should be removed, not bumped.** pako 3 ships generated types
  (`"types": "./dist/pako.d.ts"`). `@types/pako@3.0.0` is a DefinitelyTyped _stub_ whose
  own description is "Stub TypeScript definitions entry for pako, which provides its own
  types definitions". Dependabot proposed bumping it; the right move is to drop it.
- **The `legacyHash` default flip is a non-issue here — it's an improvement.** Verified
  empirically rather than assumed, since the test suite round-trips pako→pako and so
  cannot catch a wire-format problem:

  ```
  pako->zlib  : OK          # Deluge (Python zlib) can read what we send
  zlib->pako  : OK          # we can read what Deluge sends
  byte-identical to zlib: true (55 bytes both)
  zlib header byte: 0x78
  ```

  pako 3's default output is now byte-for-byte what Python/Node zlib produce, and still
  begins `0x78` — which the protocol-v0 detector at `src/DelugeRPC.ts:279` keys on. No
  code change needed for compression behaviour.

The only source change was `import pako from 'pako'` → `import * as pako from 'pako'` in
two files (v3 dropped the default export). `lint`, `bun test src`, and `build` all pass.
Nothing needed for `Uint8Array<ArrayBuffer>` narrowing in 3.0.1 — `tsc` is clean.

## Decisions already made (don't re-ask)

- Use `package-ecosystem: bun`, accepting the loss of automatic security-fix PRs.
- Batch `minor` + `patch` into one PR; let majors come individually.
- Do **not** build a lockfile-sync workflow (see dead end above).
- Weekly cadence stays.
- Keep the `@types/node` major-version pin (Node 22 LTS line).
- Auto-merge for the routine group: **yes, but not yet** — wait until one Dependabot PR
  has demonstrably arrived with `bun.lock` included, so auto-merge cannot land a broken
  lockfile unattended on a package that publishes to npm.
- Migrate `pako` to 3 rather than pinning it to `^1`.

## Plan / steps

1. [x] Diagnose why #17 is red — root cause: wrong `package-ecosystem`.
2. [x] Rewrite `.github/dependabot.yml`: `bun` ecosystem, minor/patch group, majors solo.
3. [x] Push to `master` — **Dependabot only reads config from the default branch**, so this
       change has no effect until pushed. (`2be230d..e944491`)
4. [x] Close #17 — its diff was unsalvageable (wrong grouping _and_ no lockfile).
5. [x] Migrate `pako` 1 → 3 on branch `pako-3`.
6. [x] Confirmed on Dependabot's re-run: **all four new PRs (#18–#21) include `bun.lock`**,
       and the grouping split correctly — #18 is the batched `routine` group, #19/#20/#21
       are individual majors.
7. [x] Enabled auto-merge: `allow_auto_merge` on the repo, branch protection on `master`
       requiring the `test` check, and `.github/workflows/dependabot-auto-merge.yml`.

## Progress log

- [x] Confirmed Dependabot supports text `bun.lock` — the gap was config, not tooling.
- [x] Verified `groups.*.update-types` takes `major`/`minor`/`patch` (not the
      `version-update:semver-*` spelling used by `ignore`), and that non-matching updates
      still open individual PRs.
- [x] Rewrote `.github/dependabot.yml`; pushed to `master` as `e944491`.
- [x] Closed #17 with a pointer to the root cause; its branch was deleted.
- [x] `pako` 1 → 3 migrated on branch `pako-3`; `@types/pako` dropped as redundant.
      Verified zlib wire compatibility empirically. lint + test + build green.
- [x] Dependabot re-ran on the new config immediately. **All four PRs include `bun.lock`**
      and the grouping split as intended.
- [x] Auto-merge configured and the workflow is registered and active.

### Where the open PRs stand

| PR  | What                                   | CI  | Disposition                                     |
| --- | -------------------------------------- | --- | ----------------------------------------------- |
| #18 | `routine` group, 2 updates (lock-only) | ✅  | Left for the first by-hand merge                |
| #19 | `snakecase-keys` 3.2.1 → 9.0.2 (major) | ✅  | Reviewed safe (see below); verdict posted on PR |
| #20 | `typescript` 6.0.3 → 7.0.2 (major)     | ✅  | Reviewed safe (see below); verdict posted on PR |
| #21 | Dependabot's own `pako` bump           | ❌  | Superseded by #22; leave it                     |
| #22 | `pako` 1 → 3, done properly            | ✅  | Ready to merge                                  |

### Why "CI is green" was not enough for the two majors

Both were checked past the status badge, because in each case CI structurally cannot see the
risk. Neither needed a code change; both verdicts are posted as comments on their PRs.

**#19 `snakecase-keys` 3 → 9.** The one call site is
`(snakeCaseKeys as any)(opts, { deep: true })` at `src/DelugeRPC.ts:496` — the `as any`
means `tsc` cannot catch a signature change, and `handleOptions()` has no unit coverage
(the unit tests exercise `daemon.login` wire frames, not torrent options). So a green build
says nothing here. Ran v3.2.1 and v9.0.2 side by side on a Deluge-shaped options object
with nested objects, arrays and digit-adjacent keys: **byte-identical output**, `{ deep: true }`
still honoured, `change-case` v5 treating digit boundaries the same. v9 is ESM-only, which
this package already is.

**#20 `typescript` 6 → 7.** This is the native compiler rewrite, and for a published library
the emitted `dist/` _is_ the product — CI runs `tsc` but never diffs its output. Built the
branch against a TS 6.0.3 baseline in a scratch worktree:

| Output                       | Result             |
| ---------------------------- | ------------------ |
| `.js` (runtime behaviour)    | **byte-identical** |
| `.d.ts` (published API type) | **byte-identical** |
| `.js.map` / `.d.ts.map`      | differ             |

Only source maps moved, which is expected from a different compiler implementation. Nothing
consumers execute or typecheck against changed.

**Follow-up worth doing sometime** (unrelated to the bump): that `as any` at
`src/DelugeRPC.ts:496` is precisely why six majors of drift could sail past the type checker.
Typing it properly would make the next `snakecase-keys` major self-reporting.

### The 7 skipped tests are not hidden failures

`src/integration.test.ts:116` is `describe.skipIf(skipIntegration)`, gated on `DELUGE1_PORT`
/ `DELUGE_PORT`. They need a real Deluge daemon, so they cannot run in CI — they are not
silently-broken tests.

Leave #21 alone rather than closing it: closing a Dependabot PR by hand tells Dependabot
to stop proposing that version. It closes itself once #22 lands and it sees `pako` already
at 3.x.

## Open questions for the user

_None outstanding._ Next action is time-gated, not decision-gated: wait for Dependabot's
next weekly run (step 6), then wire up auto-merge (step 7).

### Auto-merge needs a required status check to mean anything

GitHub's auto-merge only _waits_ if something is blocking the PR. `master` had no
protection, so `gh pr merge --auto` would have merged each Dependabot PR the instant it
opened — before CI ran. Enabling auto-merge without a required check is worse than not
enabling it at all.

Configured alongside it:

- `allow_auto_merge: true` on the repo.
- Branch protection on `master`: required status check `test` (the job name in `ci.yml`),
  `strict: false`, no required reviews, `allow_force_pushes: false`.
- **`enforce_admins: false`** — deliberate, so direct pushes to `master` still work for the
  repo owner, which is how this repo is normally maintained. The required check gates PR
  merges, not your own pushes.

`publish.yml` triggers only on `v*` tags and `workflow_dispatch`, never on a push to
`master`. So an auto-merged dependency update has **no automatic path to npm** — a release
still requires deliberately pushing a version tag. This is what makes unattended merging of
routine updates acceptable on a published package.

**Sharp edge:** GitHub refuses to _enable_ auto-merge on a PR with nothing left blocking it,
answering `Pull request is in clean status (enablePullRequestAutoMerge)`. Found by running
the workflow's own command against the already-green #18. It should not arise on the normal
path — when the workflow fires, CI has only just been queued, so the required check is
pending and the PR is blocked — but the workflow handles it by falling back to a direct
merge, gated on `mergeStateStatus == CLEAN` so an unrelated failure cannot merge anything.

## Things not to do

- Don't "fix" CI by dropping `--frozen-lockfile`. It is the check that caught this.
- Don't build the `workflow_run` lockfile-sync workflow (see dead end above).
- Don't merge #17. Its `pako` bump breaks three import sites and changes compression output.
- Don't add both `npm` and `bun` ecosystem entries — that produces duplicate update PRs.
