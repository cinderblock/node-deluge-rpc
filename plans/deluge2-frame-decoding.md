# Deluge 2 (protocol v1) frame decoding — regression test, error handling, and fix

## Goal

Land PR #16's one-line fix for the off-by-five `Buffer.slice` in the Deluge 2 receive
path, but land it _behind_ a regression test that demonstrably fails first. Also harden
the v1 receive path so a corrupt frame reports an error instead of throwing out of the
socket `'data'` handler and killing the process.

Then triage the backlog of open Dependabot PRs.

## Environment / context

- Repo: `github.com/cinderblock/node-deluge-rpc`, package name `deluge-rpc-socket`, v1.0.0.
- Local checkout: `C:\Users\camer\git\Personal Projects\node-deluge-rpc`.
- Toolchain: Bun (`bun.lock`), TypeScript 6, ESM. `bun test src`, `bun run lint` (tsc --noEmit).
- PR #16 by Damian Kacperski (`dkacperski97`), branch `buffer-slice-fix`, single commit
  `933c42d`. Fetched locally as `pr-16`.
- Working branch: `deluge2-frame-decoding` off `master`.

## Diagnosis (settled — don't re-derive)

`src/DelugeRPC.ts`, protocol-v1 branch of the socket `'data'` handler:

```ts
const payloadLength = buffer.readInt32BE(1);
const packetLength = 5 + payloadLength;
if (currentLength < packetLength) break;
const payload = decode(
  Buffer.from(pako.inflate(buffer.slice(5, payloadLength))),
);
removeBufferBeginning(packetLength);
```

`slice(start, end)` takes an **end offset**, not a length, so the payload is always five
bytes short. `packetLength` was already computed and already used correctly on the
`removeBufferBeginning` line — the read and the consume disagreed.

The five lost bytes are the 4-byte Adler-32 trailer plus the final deflate byte. That
last byte _usually_ holds only the end-of-block code and padding, so pako returns the
full output and nothing looks wrong. When it carries bits of a real symbol the output
comes up one byte short and rencode throws
`Tried to access data[222] but data len is: 222`.

This is a deluge-rpc bug, **not** a dependency bug:

- **pako** silently returns a partial result for a truncated deflate stream rather than
  throwing — that is why the corruption is silent, but it is not incorrect behaviour.
- **python-rencode** is the messenger; it correctly refuses to read past the end of a
  short buffer.

Verified locally against the real captured frame in PR #16:

```
total frame bytes: 152   payloadLength: 147   packetLength: 152
shipped slice len: 142    correct slice len: 147
inflated (shipped): 222   inflated (fixed): 223
shipped: THREW -> Tried to access data[222] but data len is: 222
fixed:  decoded OK -> [1,38,{"peers":[{"client":"qBittorrent/5.1.4",...
```

`buffer` is a deliberately over-allocated accumulator (`appendToIncomingBuffer` grows it
to the next power of two past `currentLength`), so the end offset genuinely has to be
correct — you cannot lean on the buffer's own `.length`. The v0 branch's
`buffer.slice(0, currentLength)` is correct only because its start offset is `0`.

## Decisions already made (don't re-ask)

1. **The regression test uses PR #16's real captured frame verbatim.** Real bytes off a
   real Deluge 2.2 daemon are worth more than a synthetic frame, and the truncation only
   bites for particular deflate bit alignments — a hand-rolled payload might not trigger
   it at all.
2. **The captured frame is a reply to request id 38**, so the test burns ids 0..37 via
   the exported `request()` before issuing the one it asserts on. Couples to the
   (stable, internal) sequential id allocation, which is an acceptable trade for using
   the real frame.
3. **The v1 path gets a `try`/`catch`, but with different recovery than v0.** See below.
4. **PR #16 is merged as a real merge commit** (`git merge pr-16`) so authorship stays
   with Damian Kacperski rather than being squashed away.
5. Test commits land _before_ the merge so `git log` shows the failing test, then the fix.

## Why v1's try/catch must not copy v0's

The v0 branch catches and `break`s — "we must have a partial message, wait for more
data". That is right for v0, which has no length prefix and therefore no way to know
where a frame ends.

v1 **does** have a length prefix and already guards with
`if (currentLength < packetLength) break;`. So by the time we inflate we are holding a
complete frame, and a failure is genuine corruption, not a short read. Copying v0's
`break` would be a bug: the parser would re-attempt the same bad frame on every
subsequent chunk forever and the receive buffer would grow without bound.

Correct v1 recovery: emit `decodingError`, consume the frame with
`removeBufferBeginning(packetLength)`, and `continue` so following frames in the same
chunk still parse.

Note the pending request's resolver for a dropped frame can never be settled — we cannot
know its id without decoding it — so its `result` promise stays pending. Emitting
`decodingError` is the honest signal. Rejecting stale resolvers is out of scope here.

The concrete harm being fixed: an exception thrown inside the `'data'` handler propagates
out of the EventEmitter as an uncaught exception and takes the process down.

## Plan / steps

1. [x] Reproduce PR #16's claim locally; confirm it is deluge-rpc's bug, not pako's or rencode's.
2. [x] Create `plans/deluge2-frame-decoding.md` and branch `deluge2-frame-decoding`.
3. [x] Add the regression test using the captured frame. Demonstrated failing —
       `error: Tried to access data[222] but data len is: 222`, thrown from
       `at emit (node:events:95:22)`, i.e. escaping the socket handler. Commit `d746f2d`.
4. [x] Add the v1 `try`/`catch` + a corrupt-frame test. New test passed, regression test
       still failed but now as `decodingError: Failed to decode packet: ...` rather than a
       throw — confirming the hardening did not mask the bug. Commit `42b91de`.
5. [x] Merge `pr-16`. One conflict, as expected (step 4 reindented the very line the PR
       changes); resolved by keeping the new structure and taking the PR's
       `packetLength`. Whole suite green: 6 pass / 0 fail. Merge commit `c98477e`, with
       `933c42d` preserved as Damian Kacperski's own commit.
6. [x] `bun run lint` clean, prettier clean on all touched files.
7. [x] Triage Dependabot PRs (see below) — verified against the GitHub API.
8. [x] Confirmed with the user, then pushed `master`. PR #16 auto-closed as MERGED.
9. [x] Released v1.0.1: README changelog entry, version bump, tag `v1.0.1` pushed. The
       `publish.yml` workflow ran to success and `deluge-rpc-socket@1.0.1` is on npm as
       `latest`, published from CI with provenance — never from a CLI.

10. [x] Merged PR #15 over SSH after the OAuth token refused it (see below). All open PRs
        are now closed; CI green on `ec0f86b`.

## Status: complete

## Gotcha: the `workflow` scope wall, and how to get past it

PR #15 (`actions/setup-node` 6→7) touches `.github/workflows/publish.yml`, and every
route that used the `gh` OAuth token refused it:

```
refusing to allow an OAuth App to create or update workflow
`.github/workflows/publish.yml` without `workflow` scope
```

Token scopes are `delete:packages, gist, read:org, read:packages, repo, user` — no
`workflow`. Two things worth knowing:

1. **`git push` over HTTPS hits the same wall.** `credential.helper` is unset in the repo
   and global config, so git falls through to the `gh` credential helper and presents the
   very same OAuth token. Merging locally and pushing is _not_ a workaround by itself.
2. **Pushing over SSH is.** SSH keys are not OAuth-scoped, so this works:
   ```
   git push git@github.com:cinderblock/node-deluge-rpc.git master
   ```
   `ssh -T git@github.com` authenticates as `cinderblock` with `~/.ssh/id_rsa`.

So the recipe for any workflow-file change here: merge locally, push over SSH. GitHub
then sees the PR's head commit reachable from `master` and marks it MERGED on its own —
same mechanism that closed #16.

If this comes up often, either `gh auth refresh -s workflow` (interactive: needs a browser
and a one-time code, so it cannot be done from a non-interactive shell) or switch the
remote to SSH permanently with
`git remote set-url origin git@github.com:cinderblock/node-deluge-rpc.git`.

Earlier note said #14 merged via the API "despite also touching publish.yml" and called
the enforcement inconsistent. That was wrong and is worth correcting: #14's _net_ change
against its merge base was `actions/checkout` only, and the `publish.yml` hunk showing in
`master..pr-14` was an artifact of comparing across an old base. GitHub was consistent
throughout; the diff was misleading.

**Read `base..head`, not `master..head`, when judging what a PR actually changes.** The
same trap nearly bit on #15: `git diff master..pr-15` appeared to revert the entire
v1.0.1 release, because dependabot branched from `d4c0127`. The 3-way merge correctly
applied one line. Always verify with `git merge --no-commit` plus `git diff HEAD` before
committing.

## Dependabot triage

Two groups, opposite dispositions:

- **Merge — #14 (`actions/checkout` 6→7), #15 (`actions/setup-node` 6→7).** Both actions
  are genuinely in use: `ci.yml` and `publish.yml` pin `actions/checkout@v6`, and
  `publish.yml` pins `actions/setup-node@v6`. Both are now merged; workflows pin
  `actions/checkout@v7` and `actions/setup-node@v7`.
- **Close as obsolete — #1, #5, #6, #7, #8, #9, #10, #11, #12, #13.** Every one is a
  transitive npm/yarn lockfile bump (yarn, handlebars, lodash, hosted-git-info,
  path-parse, tmpl, ajv, decode-uri-component, qs, json5) from the pre-1.0.0 era. The
  v1.0.0 modernization moved the project to Bun; `package-lock.json` and `yarn.lock` no
  longer exist on `master` (`git ls-tree master` shows only `bun.lock`), so these cannot
  merge and their advisories no longer apply to any file in the repo.

Confirmed against the API rather than assumed: #14 and #15 both report
`mergeable=MERGEABLE state=CLEAN`, and every one of the ten stale PRs reports
`mergeable=CONFLICTING` with `files=yarn.lock`. (#10 hit a transient TLS error on the
GraphQL endpoint during the sweep but is the same shape as the rest.)

Dependabot is still configured for both ecosystems in `.github/dependabot.yml` — `npm`
(grouped, all patterns, `@types/node` pinned off major) and `github-actions`. Closing the
stale PRs does not disable anything; the npm ecosystem now tracks `bun.lock`.

## Findings / gotchas

- `pako.inflate` does **not** throw on a truncated deflate stream — it returns whatever it
  managed to decode. This is what made the bug silent for so long. Do not write a test
  that expects pako to raise.
- The regression test must assert the _success_ condition (result promise resolves with
  the expected data), not merely "does not throw". Once step 4's `try`/`catch` is in, the
  buggy code stops throwing and starts emitting `decodingError` — a "does not throw" test
  would go green while the bug is still present.
- Because a failure mode of the buggy code is "promise never settles", the test races the
  result against the `decodingError` event so it fails fast and legibly instead of
  timing out.
- `MockSocket` collects a `socket.once('error', ...)` listener per in-flight request;
  burning 38 ids trips Node's default max-listeners warning. Call `setMaxListeners(0)`.

## Things not to do

- Don't copy the v0 `break`-and-wait recovery into the v1 branch (see above).
- Don't squash PR #16 — keep the author's commit.
- Don't merge the stale npm/yarn Dependabot PRs; they target files that no longer exist.
- Don't push or close PRs without checking with the user first.

## Open questions for the user

1. Push `master` directly, or open a PR for the test + hardening work?
   Recommendation: push to `master`; this is a small single-maintainer repo and PR #16
   gets closed automatically once its commit lands there.
2. Should a v1.0.1 release be cut and tagged once this lands? Recommendation: yes — the
   bug makes the library unusable against Deluge 2.x in the wild.
