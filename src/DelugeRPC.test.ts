import { describe, expect, test } from 'bun:test';

import { EventEmitter } from 'events';
import { Socket } from 'net';
import pako from 'pako';
import { decode } from 'python-rencode';

import DelugeRPC from './DelugeRPC.js';

/**
 * Minimal Socket stand-in that captures every `write()` so tests can
 * inspect the bytes the library puts on the wire.
 */
class MockSocket extends EventEmitter {
  written: Buffer[] = [];

  write(buff: Buffer, cb?: (err?: Error) => void): boolean {
    this.written.push(Buffer.from(buff));
    if (cb) setImmediate(cb);
    return true;
  }
}

function asSocket(m: MockSocket): Socket {
  return m as unknown as Socket;
}

/**
 * Strip the v1 wire header (`0x01` + uint32 BE length) and inflate the
 * zlib body, returning the rencoded payload as a Buffer.
 */
function unwrapV1Frame(frame: Buffer): Buffer {
  expect(frame[0]).toBe(0x01);
  const bodyLength = frame.readUInt32BE(1);
  expect(bodyLength).toBe(frame.length - 5);
  return Buffer.from(pako.inflate(frame.subarray(5)));
}

describe('daemon.login wire frame (protocol v1)', () => {
  test('sends a non-empty client_version kwarg by default', async () => {
    const socket = new MockSocket();
    const rpc = DelugeRPC(asSocket(socket), { protocolVersion: 1 });

    const { sent } = rpc.daemon.login('alice', 'hunter2');
    await sent;

    expect(socket.written).toHaveLength(1);

    const payload = decode(unwrapV1Frame(socket.written[0]!)) as any;
    // Outer shape: [[id, method, args, kwargs]]
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    const [id, method, args, kwargs] = payload[0];
    expect(typeof id).toBe('number');
    expect(method).toBe('daemon.login');
    expect(args).toEqual(['alice', 'hunter2']);
    expect(typeof kwargs.client_version).toBe('string');
    expect(kwargs.client_version.length).toBeGreaterThan(0);
  });

  test('honors the clientVersion option override', async () => {
    const socket = new MockSocket();
    const rpc = DelugeRPC(asSocket(socket), {
      protocolVersion: 1,
      clientVersion: '2.1.1',
    });

    const { sent } = rpc.daemon.login('alice', 'hunter2');
    await sent;

    const payload = decode(unwrapV1Frame(socket.written[0]!)) as any;
    expect(payload[0][3]).toEqual({ client_version: '2.1.1' });
  });
});
