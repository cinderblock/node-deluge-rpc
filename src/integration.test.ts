// Integration tests against a real Deluge daemon. Disabled by default; set
// DELUGE1_PORT (and optionally DELUGE2_PORT for both versions) to enable.
// A docker-compose-based test harness is planned for v1.1; until then these
// run only against your own daemon.

import { afterAll, describe, expect, test } from 'bun:test';
import tls from 'tls';

import DelugeRPC, { ProtocolVersion, isRPCError } from './DelugeRPC.js';
import { SharedPromise } from './utils/SharedPromise.js';

type Options = {
  connect: { host: string; port: number };
  options?: tls.ConnectionOptions;
  /**
   * Undefined means no expected version, autodetect
   */
  protocolVersion?: ProtocolVersion;
};

function testVersion({
  connect: { host, port },
  options,
  protocolVersion,
}: Options) {
  const socket = SharedPromise<tls.TLSSocket>();

  const connected = SharedPromise();
  const securelyConnected = SharedPromise();

  const RPC = SharedPromise<ReturnType<typeof DelugeRPC>>();

  test('Can connect to daemon', async () => {
    const s = tls.connect(port, host, options);
    s.on('connect', connected.resolve);
    s.on('error', connected.reject);

    socket.resolve(s);

    await connected.promise;
  });

  test('Can connect to daemon securely', async () => {
    const s = await socket.promise;
    s.on('secureConnect', securelyConnected.resolve);
    s.on('error', securelyConnected.reject);

    await securelyConnected.promise;
  });

  test('Can wrap a socket', async () => {
    const d = DelugeRPC(await socket.promise, { protocolVersion });
    RPC.resolve(d);
    await RPC.promise;
  });

  async function connect() {
    await securelyConnected.promise;
    return RPC.promise;
  }

  const detectedProtocol = SharedPromise<ProtocolVersion>();

  test('Can detect protocol version', async () => {
    try {
      const rpc = await connect();

      const { sent, result } = rpc.detectProtocolVersion();

      await sent;

      const res = await result;

      if (isRPCError(res)) {
        detectedProtocol.reject(new Error(res.error?.toString()));
      } else {
        detectedProtocol.resolve(res);
      }
    } catch (e) {
      detectedProtocol.reject(e as Error);
    }
  });

  if (protocolVersion !== undefined) {
    test('Detected version matches expected: ' + protocolVersion, async () => {
      expect(await detectedProtocol.promise).toBe(protocolVersion);
    });
  }

  test('Can run `daemon.info`', async () => {
    const rpc = await connect();
    const { sent } = rpc.daemon.info();
    await sent;
    // TODO: assert on result. Deluge 1.3.x is known not to respond.
  });

  afterAll(async () => {
    (await socket.promise).end();
  });
}

const port1 = Number(process.env.DELUGE1_PORT || process.env.DELUGE_PORT);
const host1 =
  process.env.DELUGE1_HOST || process.env.DELUGE_HOST || 'localhost';
const version1 = Number(process.env.DELUGE_PROTOCOL_VERSION) || 0 ? 1 : 0;

const port2 = Number(process.env.DELUGE2_PORT);
const host2 = process.env.DELUGE2_HOST || 'localhost';

const options: tls.ConnectionOptions = { rejectUnauthorized: false };

// Integration tests need a real Deluge daemon. Skip the whole suite when
// neither DELUGE1_PORT nor DELUGE_PORT is set, so CI can run cleanly.
const skipIntegration = !port1;

describe.skipIf(skipIntegration)('Deluge daemon (integration)', () => {
  if (port2) {
    describe('Deluge 1.x', () => {
      testVersion({
        connect: { host: host1, port: port1 },
        options,
        protocolVersion: version1,
      });
    });
    describe('Deluge 2.x', () => {
      testVersion({
        connect: { host: host2, port: port2 },
        options,
        protocolVersion: 1,
      });
    });
  } else {
    testVersion({
      connect: { host: host1, port: port1 },
      options,
      protocolVersion: version1,
    });
  }
});
