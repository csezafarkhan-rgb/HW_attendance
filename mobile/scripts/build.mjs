import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.env.HW_ATTENDANCE_SOURCE||path.join(root,'..'));
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const www=path.join(root,'www');fs.mkdirSync(path.join(www,'assets'),{recursive:true});
function replaceOnce(text,from,to){if(!text.includes(from))throw new Error('Source changed; required build marker missing: '+from);return text.replace(from,to);}
let shell=read(path.join(source,'src/shell.template.html'));
let dash=read(path.join(source,'src/attendance.html'));
let auth=read(path.join(source,'public/hw-auth.js'));
const sync=read(path.join(source,'public/hw-sync.js'));

await build({entryPoints:[path.join(root,'src/native.mjs')],bundle:true,format:'iife',target:'chrome105',outfile:path.join(www,'assets/mobile-runtime.js'),minify:true,legalComments:'eof'});
for(const f of ['mobile.css','mobile-ui.js','frame-bridge.js'])fs.copyFileSync(path.join(root,'src',f),path.join(www,'assets',f));
fs.copyFileSync(path.join(root,'node_modules/html2canvas/dist/html2canvas.min.js'),path.join(www,'assets/html2canvas.min.js'));

// Same assembly as the website, built into a separate directory. Production
// HTML, server routes, database and employee records are never changed here.
dash=replaceOnce(dash,'<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>','<script>\n'+sync+'\n</script>\n<script src="/assets/html2canvas.min.js"></script>');
dash=dash.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^;]+;/g,'');
dash=dash.replace(/(<script id="data-holder" type="application\/json">)[\s\S]*?(<\/script>)/,'$1{"employees":[],"records":[]}$2');
if(/<script>\(function\(\)\{try\{var s=JSON\.parse\(decodeURIComponent/.test(dash))throw new Error('Embedded employee seed is forbidden');
dash=replaceOnce(dash,'<head>','<head>\n<script src="/assets/frame-bridge.js"></script>');
dash=replaceOnce(dash,'</head>','<link rel="stylesheet" href="/assets/mobile.css">\n</head>');
const end=dash.lastIndexOf('</body>');if(end<0)throw new Error('Dashboard body not found');
dash=dash.slice(0,end)+'<script src="/assets/mobile-ui.js"></script>\n'+dash.slice(end);
// Avoid scheduled PC helper probes and automatic folder snapshots on a phone.
// The explicit backup/export buttons continue to use the native share sheet.
dash=replaceOnce(dash,"function autoSyncOn(){\n  try{ return localStorage.getItem(AUTOSYNC_KEY) !== '0'; }catch(e){ return true; }\n}","function autoSyncOn(){ return false; }");
dash=replaceOnce(dash,"function autoBackupOn(){ return localStorage.getItem('attDashboard_autoBackupShot')!=='0'; }","function autoBackupOn(){ return false; }");
dash=replaceOnce(dash,'function dailyBackupWatch(){','function dailyBackupWatch(){ return; // The office PC owns scheduled folder backups.\n');
// Block PC loopback before fetch without changing normal API or blob requests.
const bridgePath=path.join(www,'assets/frame-bridge.js');
fs.appendFileSync(bridgePath,"\n(function(){var f=window.fetch;window.fetch=function(u,o){if(/^http:\\/\\/(127\\.0\\.0\\.1|localhost):8765(?:\\/|$)/.test(String(u)))return Promise.reject(new Error('Office PC sync is unavailable on this phone'));return f(u,o);};})();\n");

auth=replaceOnce(auth,'function enter(user) {',`function enter(user) {
      if (!user || user.role !== 'admin') {
        apiJson('/api/logout', {method:'POST',body:'{}'}).catch(function(){});
        clearLocalData();
        showError('This app is for Super Admin accounts. Use the website for other roles.');
        return;
      }`);
shell=replaceOnce(shell,'function initLoginGate(startWorkspace){','function __legacyInitLoginGate_UNUSED(startWorkspace){');
shell=replaceOnce(shell,'<head>',`<head>
<meta name="color-scheme" content="light">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://attendance.homeweavers.net; connect-src 'self' https://attendance.homeweavers.net; frame-src 'self' data: blob:; object-src 'none'; base-uri 'self'">
<script src="/assets/mobile-runtime.js"></script>`);
shell=replaceOnce(shell,'width=device-width, initial-scale=1','width=device-width, initial-scale=1, viewport-fit=cover');
shell=replaceOnce(shell,'</head>','<script>\n'+sync+'\n</script>\n<script>\n'+auth+'\n</script>\n<link rel="stylesheet" href="/assets/mobile.css">\n</head>');
shell=replaceOnce(shell,"case 'download':",`case 'download':
        if (window.HWMobile && window.HWMobile.native) { window.HWMobile.exportBlob(m.blob, m.name); break; }`);
shell=replaceOnce(shell,'@@B64:attendance@@',Buffer.from(dash).toString('base64'));
fs.writeFileSync(path.join(www,'index.html'),shell);
fs.writeFileSync(path.join(www,'build-info.json'),JSON.stringify({name:'HW Attendance Admin',version:'1.0.0',api:'https://attendance.homeweavers.net',role:'admin',builtAt:new Date().toISOString()},null,2));
console.log('Built packaged Super Admin app: '+www+' ('+Buffer.byteLength(shell).toLocaleString()+' bytes).');
