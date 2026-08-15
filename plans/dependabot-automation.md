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

## Decisions already made (don't re-ask)

- Use `package-ecosystem: bun`, accepting the loss of automatic security-fix PRs.
- Batch `minor` + `patch` into one PR; let majors come individually.
- Do **not** build a lockfile-sync workflow (see dead end above).
- Weekly cadence stays.
- Keep the `@types/node` major-version pin (Node 22 LTS line).

## Plan / steps

1. [x] Diagnose why #17 is red — root cause: wrong `package-ecosystem`.
2. [x] Rewrite `.github/dependabot.yml`: `bun` ecosystem, minor/patch group, majors solo.
3. [ ] Push to `master` — **Dependabot only reads config from the default branch**, so this
       change has no effect until pushed.
4. [ ] Close #17 and let Dependabot re-open the split PRs (its diff is unsalvageable: wrong
       grouping _and_ no lockfile).
5. [ ] **Open question for user** — enable auto-merge for the minor/patch group?
6. [ ] Separately: migrate `pako` 1 → 3 as its own PR (real code work, not a version bump).

## Progress log

- [x] Confirmed Dependabot supports text `bun.lock` — the gap was config, not tooling.
- [x] Verified `groups.*.update-types` takes `major`/`minor`/`patch` (not the
      `version-update:semver-*` spelling used by `ignore`), and that non-matching updates
      still open individual PRs.
- [x] Rewrote `.github/dependabot.yml`.
- [ ] Pushed; awaiting first Dependabot run to confirm `bun.lock` now appears in diffs.

## Open questions for the user

1. **Auto-merge the minor/patch group once CI is green?** Requires enabling
   `allow_auto_merge` on the repo plus a small workflow calling `gh pr merge --auto`.
   _Recommendation: yes_ — but only after one manual cycle proves the `bun` ecosystem
   really does produce a lockfile, so auto-merge can't land a broken lock unattended.
   Note this repo publishes to npm, so a bad auto-merge has a path to a release.
2. **Take the `pako` 1 → 3 migration now, or pin `pako` to `^1`?** The v3 rewrite touches
   compression on the Deluge wire protocol and deserves its own PR with the existing
   regression tests as the check.

## Things not to do

- Don't "fix" CI by dropping `--frozen-lockfile`. It is the check that caught this.
- Don't build the `workflow_run` lockfile-sync workflow (see dead end above).
- Don't merge #17. Its `pako` bump breaks three import sites and changes compression output.
- Don't add both `npm` and `bun` ecosystem entries — that produces duplicate update PRs.
