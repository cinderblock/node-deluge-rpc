# Node.js Deluge RPC Socket

Node.js API for Deluge's RPC API

[![](https://github.com/cinderblock/node-deluge-rpc/workflows/Main/badge.svg)](https://github.com/cinderblock/node-deluge-rpc/actions)
[![Coverage Status](https://coveralls.io/repos/github/cinderblock/node-deluge-rpc/badge.svg?branch=rework-api)](https://coveralls.io/github/cinderblock/node-deluge-rpc?branch=rework-api)

## Setup

```bash
yarn add deluge-rpc-socket
```

## Usage

```js
const tls = require('tls');
const DelugeRPC = require('deluge-rpc-socket').default;

const socket = tls.connect(58846, {
  // Deluge often runs with self-signed certificates
  rejectUnauthorized: false,
});

const rpc = DelugeRPC(socket);

// Wait for socket.on('secureConnect', ...)

// `sent` monitors if the request was actually sent to Deluge or if there was some error on our end
// `result` resolves when we get a response from the remote server
let { result, sent } = rpc.daemon.login('username', 'password');

// Monitor socket status
sent
  .then(() => {
    console.log('Message sent');
  })
  .catch(() => {
    console.log('Message not sent');
  });

// If message was not sent, this will never resolve.
result.then(({ error, response }) => {
  console.log(error || response);
});

// Listen for asynchronous events from daemon
rpc.events.on('delugeEvent', console.log);

// Non fatal decoding errors that indicate something is wrong with the protocol...
rpc.events.on('decodingError', console.log);
```

### Arguments

All arguments to API functions at any depth can be Promises.

#### camelCase vs snake_case

All of Deluge's arguments are snake_case.
Any named arguments will be converted to Deluge's snake_keys convention.

## Change Log

### v0.5.0

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
