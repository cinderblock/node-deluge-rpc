console.log();
console.log('Check history for useful commands');
console.log();

const repl = require('repl-live').start({
  ignoreUndefined: true,
  requires: {
    DelugeRPC: './DelugeRPC.js',
    config: './config.js',
  },
});

repl.rli.history = [
  "  (typeof c != 'undefined' && c.end()); (rpc = DelugeRPC(c = tls.connect(config)) ) && rpc.events.on('delugeEvent', console.log) && true",
  '  res = rpc.login(config.user, config.password)',
  "  rpc.getVersion().result.catch(() => {console.log('Looks like v1.x')}).then(console.log) && true",
  '  c.end()',
];
