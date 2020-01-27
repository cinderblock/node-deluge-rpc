import tls from 'tls';

// import DelugeRPC from '..';
import DelugeRPC, { ProtocolVersion, isRPCError } from '../src/DelugeRPC';
// import DelugeRPC from 'deluge-rpc-socket';

import { SharedPromise } from '../src/utils/SharedPromise';

type Options = {
  connect: { host: string; port: number };
  options?: tls.ConnectionOptions;
  /**
   * Undefined means no expected version, autodetect
   * */
  protocolVersion?: ProtocolVersion;
};

function testVersion(
  test: jest.It,
  { connect: { host, port }, options, protocolVersion }: Options,
) {
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
    const d = DelugeRPC(await socket.promise, {
      protocolVersion,
    });

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
      detectedProtocol.reject(e);
    }
  });

  if (protocolVersion !== undefined) {
    test('Detected version matches expected: ' + protocolVersion, async () => {
      expect(await detectedProtocol.promise).toBe(protocolVersion);
    });
  }

  test('Can run `daemon.info`', async () => {
    const rpc = await connect();

    const { sent, result } = rpc.daemon.info();

    await sent;

    // Why does daemon 1.3.x not respond?
    // const res = await result;

    // TODO: Finish this test
  });

  afterAll(async () => {
    (await socket.promise).end();
  });
}

// TODO: read from config.js instead of environment variables?

const port1 =
  Number(process.env.DELUGE1_PORT || process.env.DELUGE_PORT) || 58846;

const host1 =
  process.env.DELUGE1_HOST || process.env.DELUGE_HOST || 'localhost';

const version1 = Number(process.env.DELUGE_PROTOCOL_VERSION) || 0 ? 1 : 0;

const port2 = Number(process.env.DELUGE2_PORT);
const host2 = process.env.DELUGE2_HOST || 'localhost';

const options = {
  rejectUnauthorized: false,
};

function firstTests() {
  testVersion(test, {
    connect: { host: host1, port: port1 },
    options,
    protocolVersion: version1,
  });
}

if (!port2) {
  firstTests();
} else {
  describe('Deluge 1.x', firstTests);
  describe('Deluge 2.x', () => {
    testVersion(test, {
      connect: { host: host2, port: port2 },
      options,
      protocolVersion: 1,
    });
  });
}
