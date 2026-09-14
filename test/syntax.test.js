// Parse every piece of script in the project, so a typo in an edit fails here
// instead of reaching staff as a blank page or a server that will not start.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let checked = 0, bad = 0;

function parse(code, label) {
  checked++;
  try { new vm.Script(code, { filename: label }); }
  catch (e) { bad++; console.log('FAIL syntax error in ' + label + ': ' + e.message); }
}
// Inline scripts of an HTML file. JSON holders and the base64 placeholder are data, not code.
function inlineScripts(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    n++;
    if (/\bsrc=/.test(attrs) || /application\/json/.test(attrs)) continue;
    if (/text\/plain/.test(attrs) && !/id="child-shim"/.test(attrs)) continue;
    parse(m[2], file + ' script #' + n);
  }
}
inlineScripts('src/attendance.html');
inlineScripts('src/shell.template.html');
['server.js', 'migrate.js', 'public/hw-sync.js', 'public/hw-auth.js',
 'scripts/create-user.js', 'scripts/attendance-sync/sync-service.js'].forEach(function (f) {
  // wrapped as a function body so CommonJS top-level return and require parse
  parse('(function(require,module,exports,__dirname,__filename){' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n})', f);
});
console.log((bad ? 'SOME FAILED' : 'ALL PASS') + ' (' + checked + ' scripts parsed, ' + bad + ' with errors)');
process.exitCode = bad ? 1 : 0;
