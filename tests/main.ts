import tls from 'tls';

// import DelugeRPC from '..';
import DelugeRPC from '../src/DelugeRPC.js';
// import DelugeRPC from 'deluge-rpc-socket';

import { SharedPromise } from './utils/SharedPromise';

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

testDeluge({
  connect: { host: host1, port: port1 },
  options,
  expectedVersion: version1,
  name: port2 ? 'Deluge 1.x' : undefined,
});

if (port2) {
  testDeluge({
    connect: { host: host2, port: port2 },
    options,
    expectedVersion: 1,
    name: 'Deluge 2.x',
  });
}

type Options = {
  connect: { host: string; port: number };
  options?: tls.ConnectionOptions;
  expectedVersion: 0 | 1;
  name?: string;
};

function testDeluge({ connect, options, expectedVersion, name }: Options) {
  name += ' - ';

  const socket = SharedPromise<tls.TLSSocket>();

  const connected = SharedPromise();

  const RPC = SharedPromise<ReturnType<typeof DelugeRPC>>();

  test(name + 'Connect', async () => {
    socket.resolve(
      tls.connect(port1, host1, options).on('secureConnect', connected.resolve)
    );

    await connected.promise;
  });

  test(name + 'Wrap with Daemon', async () => {
    RPC.resolve(DelugeRPC(await socket.promise));

    await RPC.promise;
  });

  test(name + 'Get version', async () => {
    await connected;
    const rpc = await RPC.promise;

    const { sent, result } = rpc.daemon.info();

    await sent;

    const res = await result;

    console.log('res');
    console.log(res);
  });
}
