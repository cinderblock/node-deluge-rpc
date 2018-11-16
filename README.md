# node-deluge-rpc-socket

Node.js API for Deluge's RPC API

## Setup

```bash
yarn add deluge-rpc-socket
```

## Usage

```js
const tls = require('tls');
const DelugeRPC = require('deluge-rpc-socket');

const socket = tls.connect(
  58846,
  {
    // Deluge often runs with self-signed certificates
    rejectUnauthorized: false,
  }
);

const rpc = DelugeRPC(socket);

let { result, sent } = rpc.login('username', 'password');

// Monitor socket status
sent.catch(console.error).then(() => {
  console.log('Message sent');
});

// Responses are resolved. Error responses are rejections.
result.catch(console.error).then(console.log);

// Listen for asynchronous events from daemon
rpc.events.on('delugeEvent', console.log);

// Non fatal decoding errors that indicate something is wrong with the protocol...
rpc.events.on('decodingError', console.log);
```

### Alternate API: Don't throw on error responses

```js
const alt = DelugeRPC(socket, { resolveErrorResponses: true });

let { result, sent } = rpc.request('daemon.info');

sent.then(socketError => {
  console.log(socketError || 'Message sent');
});

result.then(({ error, data }) => {
  if (error) {
    console.log(error);
    return;
  }
  console.log(data);
});
```

## Development

```bash
yarn setup
# Launch a REPL with `DelugeRPC` and `config` available in the context and useful commands in history
yarn start
```
