import tls from 'tls';

// import DelugeRPC from '..';
import DelugeRPC, { ProtocolVersion, isRPCError } from '../dist/DelugeRPC.js';
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
  { connect: { host, port }, options, protocolVersion }: Options
) {
  const socket = SharedPromise<tls.TLSSocket>();

  const connected = SharedPromise();

  const RPC = SharedPromise<ReturnType<typeof DelugeRPC>>();

  test('Connect', async () => {
    const s = tls.connect(port, host, options);
    s.on('secureConnect', connected.resolve);
    s.on('error', connected.reject);

    socket.resolve(s);

    await connected.promise;
  });

  test('Wrap with Daemon', async () => {
    const d = DelugeRPC(await socket.promise, {
      protocolVersion,
    });

    RPC.resolve(d);

    await RPC.promise;
  });

  async function connect() {
    await connected.promise;
    return RPC.promise;
  }

  test('Get Version', async () => {
    const rpc = await connect();

    const { sent, result } = rpc.daemon.info();

    await sent;

    const res = await result;

    // TODO check it. For now, error
    throw new Error('Finish this test');
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
