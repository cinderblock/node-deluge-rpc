import { describe, expect, test } from 'bun:test';

import { EventEmitter } from 'events';
import { Socket } from 'net';
import pako from 'pako';
import { encode, decode } from 'python-rencode';
import type { RencodableData } from 'python-rencode';

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

/** Wrap a zlib body in a protocol v1 frame: `0x01` + uint32 BE length + body. */
function makeV1Frame(body: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Build the v1 frame a daemon would send as a successful reply to `id`. */
function makeV1Response(id: number, data: RencodableData): Buffer {
  return makeV1Frame(Buffer.from(pako.deflate(encode([1, id, data]))));
}

/**
 * Consume request ids so that the next `request()` is handed `id`. Ids are allocated
 * sequentially from 0, which lets a test line its resolver up with a captured frame.
 */
function burnRequestIds(rpc: ReturnType<typeof DelugeRPC>, id: number) {
  for (let i = 0; i < id; i++) rpc.request('daemon.info');
}

/**
 * Reject as soon as the library reports a decoding problem. A frame the library fails to
 * decode leaves its request's `result` promise pending forever, so tests race against
 * this instead of waiting out the test timeout with no explanation.
 */
function decodingErrors(rpc: ReturnType<typeof DelugeRPC>): Promise<never> {
  return new Promise((_, reject) => {
    rpc.events.on('decodingError', (...args: unknown[]) =>
      reject(new Error(`decodingError: ${args.join(' ')}`)),
    );
  });
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

/**
 * A real `core.get_torrent_status` reply captured off a Deluge 2.2 daemon, contributed in
 * https://github.com/cinderblock/node-deluge-rpc/pull/16 with the peer addresses swapped
 * for RFC 5737 documentation ones. It is a reply to request id 38.
 *
 * These bytes matter exactly as they are. Reading the payload five bytes short drops the
 * Adler-32 trailer plus the final deflate byte, and that byte usually holds nothing but
 * the end-of-block code and padding — so most frames still inflate whole and the mistake
 * hides. This is a frame where the byte carries real symbol bits, so the output comes up
 * one byte short (222 instead of 223) and rencode reads off the end. Re-encoding this
 * payload would very likely land on a harmless bit alignment and quietly stop testing
 * anything.
 */
const CAPTURED_V1_FRAME = Buffer.from(
  'AQAAAJN4nDvMqJbeWpCaWlR8KLctOSczNa9kYqFTZklJflERkK1vqmeoZ9KenF+aV1JU2dCV' +
    'kl+eF18MVJ/C0JRZMNnQ0kLP1FDP0MBAz8jAwMrY2MSko6AoP70otbhYx/6Vbe4BBgaGlmKQ' +
    '8o7SAohG+6BKMmwyMjDWM9AzNDTWMzQxtzIxNzG2QLHpvwMWm1QKACSvUKY=',
  'base64',
);

const CAPTURED_V1_FRAME_REQUEST_ID = 38;

describe('response decoding (protocol v1)', () => {
  test('decodes a captured Deluge 2.2 frame whose trailing deflate byte carries data', async () => {
    const socket = new MockSocket();
    // Every in-flight request adds an 'error' listener, and we are about to have 39.
    socket.setMaxListeners(0);
    const rpc = DelugeRPC(asSocket(socket), { protocolVersion: 1 });

    burnRequestIds(rpc, CAPTURED_V1_FRAME_REQUEST_ID);
    const { result } = rpc.request('core.get_torrent_status');

    socket.emit('data', CAPTURED_V1_FRAME);

    const status = (await Promise.race([result, decodingErrors(rpc)])) as any;
    expect(status.peers).toHaveLength(2);
    expect(status.peers[0].client).toBe('qBittorrent/5.1.4');
    expect(status.peers[0].ip).toBe('198.51.100.200:3344');
    expect(status.peers[0].upSpeed).toBe(21113);
    expect(status.peers[1].ip).toBe('203.0.113.147:47438');
  });

  test('parses two frames delivered in a single chunk', async () => {
    const socket = new MockSocket();
    const rpc = DelugeRPC(asSocket(socket), { protocolVersion: 1 });

    const { result: first } = rpc.request('daemon.info');
    const { result: second } = rpc.request('daemon.info');

    socket.emit(
      'data',
      Buffer.concat([makeV1Response(0, '2.2.0'), makeV1Response(1, '2.2.1')]),
    );

    expect(
      await Promise.race([Promise.all([first, second]), decodingErrors(rpc)]),
    ).toEqual(['2.2.0', '2.2.1']);
  });

  test('parses a frame split across chunks', async () => {
    const socket = new MockSocket();
    const rpc = DelugeRPC(asSocket(socket), { protocolVersion: 1 });

    const { result } = rpc.request('daemon.info');

    const frame = makeV1Response(0, '2.2.0');
    socket.emit('data', frame.subarray(0, 7));
    socket.emit('data', frame.subarray(7));

    expect(await Promise.race([result, decodingErrors(rpc)])).toBe('2.2.0');
  });
});
