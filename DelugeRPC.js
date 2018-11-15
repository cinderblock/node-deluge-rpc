'use strict';

const EventEmitter = require('events').EventEmitter;
const pako = require('pako');
const { encode, decode } = require('python-rencode');

function newSize(needed) {
  return 1 << (needed - 1).toString(2).length;
}

function DelugeRPC(socket, options) {
  options = options || {};

  let debug = options.debug;
  // const user = options.user;
  // const password = options.password;
  const protocolVersion = options.protocolVersion || 0;
  const resolveErrorResponses = options.resolveErrorResponses;

  let nextRequestId = 0;
  const resolvers = {};
  let buffer = Buffer.allocUnsafe(0);
  let currentLength = 0;

  if (typeof debug == 'function') {
    // All set
  } else if (debug === true) {
    debug = (...args) => {
      console.log('DEBUG:', ...args);
    };
  } else {
    debug = () => {};
  }

  const events = new EventEmitter();

  function appendToIncomingBuffer(buff) {
    const newLength = currentLength + buff.length;
    if (newLength > buffer.length) {
      const old = buffer;
      buffer = Buffer.allocUnsafe(newSize(newLength));
      old.copy(buffer);
    }
    buff.copy(buffer, currentLength);
    currentLength = newLength;
  }

  function removeBufferBeginning(size) {
    buffer.copy(buffer, 0, size, currentLength);
    currentLength -= size;
  }

  function getResolvers(id) {
    const ret = resolvers[id];
    delete resolvers[id];
    return ret;
  }

  function saveResolvers(id, p) {
    resolvers[id] = !resolveErrorResponses
      ? p
      : {
          resolve: response => {
            p.resolve({ response });
          },
          reject: error => {
            p.resolve({ error });
          },
        };
  }

  function handlePayload(buff) {
    const RESPONSE = 1;
    const ERROR = 2;
    const EVENT = 3;
    const decoded = decode(buff, true);

    debug('Decoded Data!');
    debug(decoded);

    const [type, id, data] = decoded;

    if (type == RESPONSE) {
      getResolvers(id).resolve(data);
    } else if (type == ERROR) {
      getResolvers(id).reject(data);
    } else if (type == EVENT) {
      events.emit('delugeEvent', { name: id, data });
    } else {
      events.emit('decodingError', 'Invalid payload type received:', type);
    }
  }

  socket.on('data', data => {
    appendToIncomingBuffer(data);

    if (currentLength < 1) return;

    const header = buffer[0];

    if (header == 0x78) {
      // Detect common zlib header as format from Deluge ^1.0.0
      try {
        const payload = Buffer.from(pako.inflate(new Uint8Array(buffer, 1, currentLength - 1)));
        removeBufferBeginning(currentLength);
        handlePayload(payload);
        return;
      } catch (err) {
        debug('Error inflating data');
        debug(err);

        // This just means we don't have a full packet from the server back yet.
        // TODO: confirm ^^^
        return;
      }
    } else if (header == 1) {
      // Deluge ^2.0.0 (under development)
      if (currentLength < 5) return;
      const payloadLength = buffer.readInt32BE(1);
      const packetLength = 5 + payloadLength;
      if (currentLength < packetLength) return;

      // Copy the payload from the working buffer
      const payload = Buffer.from(pako.inflate(new Uint8Array(buffer, 5, payloadLength)));
      removeBufferBeginning(packetLength);
      handlePayload(payload);
    } else {
      events.emit('decodingError', 'Invalid header received:', header);
    }
  });

  function rawSend(data, cb) {
    let buff = pako.deflate(encode(data));

    if (protocolVersion == 0) {
    } else if (protocolVersion == 1) {
      // TODO: Test this with deluge dev version
      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(protocolVersion, 0);
      header.writeUInt32BE(buff.length, 1);
      buff = Buffer.concat(header, buff);
    } else {
      throw Error('Unknown protocol version!');
    }

    socket.write(buff, cb);
  }

  function request(method, args, kwargs) {
    if (kwargs === undefined && args !== undefined && !Array.isArray(args)) {
      kwargs = args;
      args = undefined;
    }

    const id = nextRequestId++;

    const result = new Promise((resolve, reject) => {
      saveResolvers(id, { resolve, reject });
    });

    const sent = new Promise((resolve, reject) => {
      rawSend([[id, method, args, kwargs]], resolve);

      // TODO: confirm this works as intended
      socket.on('error', reject);
    });

    return { result, sent };
  }

  return { request, events };
}

module.exports = DelugeRPC;
