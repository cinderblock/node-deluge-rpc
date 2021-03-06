console.log();
console.log('Check history for useful commands. (Press up)');
console.log();

const tls = require('tls');

const repl = require('repl-live').start({
  ignoreUndefined: true,
  requires: {
    DelugeRPC: '.',
    config: './config.js',
  },
});

repl.context.end = () => {
  if (repl.context.connection) {
    repl.context.connection.end();
  }
};

repl.context.connect = (config: undefined | { tls: {}; rpcOpts: {} }) => {
  config = config || <{ tls: {}; rpcOpts: {} }>repl.context.config;
  repl.context.end();
  repl.context.connection = tls.connect(config.tls);
  repl.context.rpc = repl.context.DelugeRPC.default(
    repl.context.connection,
    config.rpcOpts
  );
  repl.context.rpc.events.on('delugeEvent', console.log);
};

repl.context.login = async (
  config: undefined | { login: { user: string; pass: string } }
) => {
  config =
    config || <{ login: { user: string; pass: string } }>repl.context.config;
  const ret = repl.context.rpc.daemon.login(
    config.login.user,
    config.login.pass
  );

  ret.sent
    .catch((e: Error) => {
      console.log('Failed to send', e);
    })
    .then(() => {
      ret.result
        .catch((e: Error) => {
          console.log('login failed:', e);
        })
        .then((level: number) => {
          console.log('Auth level:', level);
        });
    });

  repl.context.res = ret;
};

repl.rli.history = [
  'connect(config)',
  'login(config)',
  "res = rpc.daemon.info().result.then(({response, error}) => console.log(error ? 'Looks like v1.x' : response)); undefined",
  'res = rpc.core.getSessionState().result.then(t => console.log(torrents = t.response)); undefined',
  'c.end()',
];

repl.on('exit', repl.context.end);
