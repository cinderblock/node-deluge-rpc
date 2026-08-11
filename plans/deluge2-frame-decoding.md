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
3. [ ] **← current** Add the regression test using the captured frame. Demonstrate it fails.
4. [ ] Add the v1 `try`/`catch` + a corrupt-frame test. Demonstrate the new test passes and
       the regression test still fails (now as a `decodingError` rather than a throw).
5. [ ] Merge `pr-16`. Demonstrate the whole suite passes.
6. [ ] `bun run lint` + `bun run format`, commit.
7. [ ] Triage Dependabot PRs (see below).
8. [ ] Confirm with the user before pushing anything to GitHub.

## Dependabot triage

Two groups, opposite dispositions:

- **Merge — #14 (`actions/checkout` 6→7), #15 (`actions/setup-node` 6→7).** Both actions
  are genuinely in use: `ci.yml` and `publish.yml` pin `actions/checkout@v6`, and
  `publish.yml` pins `actions/setup-node@v6`.
- **Close as obsolete — #1, #5, #6, #7, #8, #9, #10, #11, #12, #13.** Every one is a
  transitive npm/yarn lockfile bump (yarn, handlebars, lodash, hosted-git-info,
  path-parse, tmpl, ajv, decode-uri-component, qs, json5) from the pre-1.0.0 era. The
  v1.0.0 modernization moved the project to Bun; `package-lock.json` and `yarn.lock` no
  longer exist on `master` (`git ls-tree master` shows only `bun.lock`), so these cannot
  merge and their advisories no longer apply to any file in the repo.

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
