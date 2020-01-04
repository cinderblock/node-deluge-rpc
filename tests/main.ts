import tls from 'tls';

// import DelugeRPC from '..';
import DelugeRPC from '../src/DelugeRPC.js';
// import DelugeRPC from 'deluge-rpc-socket';

import { SharedPromise } from './utils/SharedPromise';

type Options = {
  connect: { host: string; port: number };
  options?: tls.ConnectionOptions;
  expectedVersion: 0 | 1;
};

function testVersion(
  test: jest.It,
  { connect: { host, port }, options, expectedVersion }: Options
) {
  const socket = SharedPromise<tls.TLSSocket>();

  const connected = SharedPromise();

  const RPC = SharedPromise<ReturnType<typeof DelugeRPC>>();

  test('Connect', async () => {
    socket.resolve(
      tls.connect(port, host, options).on('secureConnect', connected.resolve)
    );

    await connected.promise;
  });

  test('Wrap with Daemon', async () => {
    const d = DelugeRPC(await socket.promise, {
      protocolVersion: expectedVersion,
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

    console.log('res');
    console.log(res);
  });

  afterAll(async () => {
    (await socket.promise).end();
  });
}

const port1 =
  Number(process.env.DELUGE1_PORT || process.env.DELUGE_PORT) || 58846;

const host1 =
  process.env.DELUGE1_HOST || process.env.DELUGE_HOST || 'localhost';

const version1 =
  (process.env.DELUGE1_VERSION || process.env.DELUGE_VERSION) ?? 0 ? 1 : 0;

const port2 = Number(process.env.DELUGE2_PORT);
const host2 = process.env.DELUGE2_HOST || 'localhost';

const options = {
  rejectUnauthorized: false,
};

function firstTests() {
  testVersion(test, {
    connect: { host: host1, port: port1 },
    options,
    expectedVersion: version1,
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
      expectedVersion: 1,
    });
  });
}
