# deluge-rpc-socket

Node.js client for Deluge's binary RPC socket API. Works against Deluge 1.x
(protocol v0) and 2.x (protocol v1), auto-detects which one the daemon
speaks.

[![CI](https://github.com/cinderblock/node-deluge-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/node-deluge-rpc/actions/workflows/ci.yml)

## Install

```bash
bun add deluge-rpc-socket
# or
npm install deluge-rpc-socket
```

ESM-only. Requires Bun ≥ 1.3 or Node ≥ 22.

## Usage

```ts
import DelugeRPC, { isRPCError } from 'deluge-rpc-socket';
import { connect } from 'tls';

const socket = connect(58846, {
  // Deluge daemons usually use a self-signed certificate
  rejectUnauthorized: false,
});

const rpc = DelugeRPC(socket);

// Asynchronous events from the daemon (torrent state changes, etc.)
rpc.events.on('delugeEvent', console.log);

// Non-fatal decoding errors — something's wrong with the wire format
rpc.events.on('decodingError', console.log);

// Wait for socket.on('secureConnect', ...) before issuing RPC calls

async function login(username: string, password: string): Promise<boolean> {
  const { result, sent } = rpc.daemon.login(username, password);

  try {
    await sent;
  } catch {
    console.log('Login message not sent');
    return false;
  }

  const res = await result;
  if (isRPCError(res)) {
    console.log('Login error:', res.error);
    return false;
  }

  return true;
}

async function addTorrent(url: string): Promise<boolean> {
  const { result, sent } = rpc.core.addTorrentUrl(url);
  await sent;
  const res = await result;
  return !isRPCError(res);
}
```

### Deluge 2.x and `client_version`

Deluge 2.x's `daemon.login` raises `IncompatibleClient` if the request
doesn't include a `client_version` kwarg. This library always sends one;
the default is its own package version. Override it if you need to
impersonate a specific Deluge client:

```ts
const rpc = DelugeRPC(socket, { clientVersion: '2.1.1' });
```

### Arguments

All arguments to API functions at any depth can be promises — they are
awaited before being sent.

### camelCase vs snake_case

Deluge's wire format uses snake_case. Named option arguments accept
camelCase and are converted automatically. Responses are also converted
to camelCase by default; opt out with `camelCaseResponses: false`.

## Change Log

### v1.0.0

Promoted from `1.0.0-alpha` after consumer validation against a real
Deluge 2.x daemon. No functional changes from the alpha.

- **Toolchain:** Bun-first; ESM; TypeScript 6; dropped yarn/ts-jest/ts-node/coveralls/cspell.
- **Deps:** Bumped `python-rencode` to `^2.0.0` and `smallest-power-of-two` to `^2.0.0`.
- **Tests:** Ported from jest to `bun:test`. Integration tests against a real
  daemon now gate on `DELUGE1_PORT` (or `DELUGE_PORT`) and are skipped in CI.
- **CI:** New bun-based `ci.yml` and `publish.yml`; publishing uses npm
  Trusted Publishing (OIDC, with provenance). Pre-release versions go to
  the `next` dist-tag.
- **Breaking:** ESM-only, no CommonJS `require`. The runtime API is unchanged
  from `v0.5.0`; migration is just the import switch.

### v0.5.0

- Fixed `IncompatibleClient` when logging in to Deluge 2.x daemons by
  sending the required `client_version` kwarg (it was never sent in
  v0.4.0). Added a `clientVersion` factory option.
- Replaced the broken legacy publish job with a tag-triggered Trusted
  Publishing workflow.

### v0.4.0 and earlier

See [git tags](https://github.com/cinderblock/node-deluge-rpc/tags).

## Development

```bash
bun install
bun run lint     # type-check
bun test src     # unit tests
bun run build    # tsc → dist/
```

Integration tests against a real Deluge daemon:

```bash
DELUGE1_PORT=58846 DELUGE1_HOST=localhost bun test src
```
