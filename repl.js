console.log();
console.log('Cheat sheet:');
console.log(
  "  (typeof c != 'undefined' && c.end()); (rpc = DelugeRPC(c = tls.connect(config)) ) && rpc.events.on('delugeEvent', console.log) && true"
);
console.log('  res = rpc.login(config.user, config.password)');
console.log("  rpc.getVersion().result.catch(() => {console.log('Looks like v1.x')}).then(console.log) && true");
console.log('  c.end()');
console.log();

require('repl-live').start({
  ignoreUndefined: true,
  requires: {
    DelugeRPC: './DelugeRPC.js',
    config: './config.js',
  },
});
