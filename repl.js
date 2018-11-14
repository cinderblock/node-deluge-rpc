const r = require('repl').start({ ignoreUndefined: true });
const c = r.context;

c.api = require('./api.js');

try {
  c.config = require('./config.js');
} catch (e) {
  console.log(e);
  process.exit(1);
}
