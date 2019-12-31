import tls from 'tls';

import DelugeRPC from '..';
// import DelugeRPC from 'deluge-rpc-socket';

type SharedPromise<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: Error) => void;
};

function SharedPromise<T = undefined>(): SharedPromise<T> {
  const ret = {} as SharedPromise<T>;

  ret.promise = new Promise<T>((resolve, reject) => {
    ret.resolve = resolve;
    ret.reject = reject;
  });

  return ret;
}

const port = Number(process.env.TEST_DELUGE_PORT) || 58846;
const host = process.env.TEST_DELUGE_HOST || 'localhost';

const options = {
  rejectUnauthorized: false,
};

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
  RPC.resolve(DelugeRPC(await socket.promise));

  await RPC.promise;
});

test('Get version', async () => {
  await connected;
  const rpc = await RPC.promise;

  const { sent, result } = rpc.daemon.info();

  await sent;

  const res = await result;

  console.log('res');
  console.log(res);
});