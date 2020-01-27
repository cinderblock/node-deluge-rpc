# Node.js Deluge RPC Socket

Node.js API for Deluge's RPC API

[![](https://github.com/cinderblock/node-deluge-rpc/workflows/Main/badge.svg?branch=master)](https://github.com/cinderblock/node-deluge-rpc/actions?query=branch%3Amaster)
[![Coverage Status](https://coveralls.io/repos/github/cinderblock/node-deluge-rpc/badge.svg?branch=master)](https://coveralls.io/github/cinderblock/node-deluge-rpc?branch=master)

## Setup

```bash
yarn add deluge-rpc-socket
```

## Usage

```ts
import Deluge, { isRPCError } from 'deluge-rpc-socket';
import { connect } from 'tls';

const socket = tls.connect(58846, {
  // Deluge often runs with self-signed certificates
  rejectUnauthorized: false,
});

const rpc = DelugeRPC(socket);

// Listen for asynchronous events from daemon
rpc.events.on('delugeEvent', console.log);

// Non fatal decoding errors that indicate something is wrong with the protocol...
rpc.events.on('decodingError', console.log);

// Wait for socket.on('secureConnect', ...) event before running the following example functions

async function login(username: string, password: string): Promise<boolean> {
  // `sent` monitors if the request was actually sent to Deluge or if there was some error on our end
  // `result` resolves when we get a response from the remote server
  const { result, sent } = rpc.daemon.login(username, password);

  try {
    await sent;
  } catch (e) {
    console.log('Login message not sent');
    return false;
  }

  console.log('Login message sent');

  // If message was not sent, this will never resolve.
  const res = await result;

  if (isRPCError(res)) {
    console.log('Error result!');
    console.log(res.error);
    return false;
  }

  console.log('Login result:');
  console.log(res);

  return true;
}

async function addTorrent(url: string): Promise<boolean> {
  // `sent` monitors if the request was actually sent to Deluge or if there was some error on our end
  // `result` resolves when we get a response from the remote server
  const { result, sent } = rpc.core.addTorrentUrl(url);

  try {
    await sent;
  } catch (e) {
    console.log('Add Torrent message not sent');
    return false;
  }

  console.log('Add Torrent message sent');

  // If message was not sent, this will never resolve.
  const res = await result;

  if (isRPCError(res)) {
    console.log('Error result from Add Torrent!');
    console.log(res.error);
    return false;
  }

  console.log('Add Torrent result:', res);

  return true;
}
```

### Arguments

All arguments to API functions at any depth can be Promises.

#### camelCase vs snake_case

All of Deluge's arguments are snake_case.
Any named arguments will be converted to Deluge's snake_keys convention.

## Change Log

### v0.5.0 (WIP)

#### Breaking changes

- Removed "Alternate API" and made it default

#### New Features

- Automatic detection of remote version
- Automated testing against versions
- Consistent Typings on API
- Made new Alternate API that is more like the original but has stricter types (WIP)

### v0.4.0

_TODO_

<!-- NOPUBLISH -->

## Development

```bash
yarn setup
# Launch a REPL with `DelugeRPC` and `config` available in the context and useful commands in history
yarn start
```
