console.log();
console.log('Check history for useful commands');
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
  'connect()',
  'login()',
  "rpc.daemon.info().result.catch(() => {console.log('Looks like v1.x')}).then(console.log) && true",
  'res = rpc.core.getSessionState()',
  'c.end()',
];

repl.on('exit', repl.context.end);
