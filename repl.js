console.log();
console.log('Cheat sheet:');
console.log('  (rpc = DelugeRPC(c = tls.connect(config)) ) && true');
console.log(
  "  rpc.rpcCall('daemon.info').result.catch(() => {console.log('Looks like v1.x')}).then(console.log) && true"
);
console.log('  c.end()');
console.log();

require('repl-live').start({
  ignoreUndefined: true,
  requires: {
    DelugeRPC: './DelugeRPC.js',
    config: './config.js',
  },
});
