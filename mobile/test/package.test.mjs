import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shell=fs.readFileSync(path.join(root,'www/index.html'),'utf8');
const encoded=shell.match(/<script[^>]+id="src-attendance"[^>]*>([\s\S]*?)<\/script>/);
assert.ok(encoded,'Packaged attendance dashboard exists');
const dashboard=Buffer.from(encoded[1].trim(),'base64').toString('utf8');
test('packaged dashboard contains no embedded employee records',()=>{
  const data=dashboard.match(/<script id="data-holder" type="application\/json">([\s\S]*?)<\/script>/);
  assert.deepEqual(JSON.parse(data[1]),{employees:[],records:[]});
  assert.ok(!dashboard.includes('Asha Demo'));
});
test('Super Admin role is required before hydrating any admin data',()=>{
  const enter=shell.indexOf('function enter(user) {');
  const guard=shell.indexOf("user.role !== 'admin'",enter);
  const hydrate=shell.indexOf('window.HWSync.hydrate()',enter);
  assert.ok(guard>enter&&guard<hydrate);
  assert.ok(shell.slice(guard,hydrate).includes("apiJson('/api/logout'"));
});
test('required assets are local and mobile bridge starts before API code',()=>{
  assert.ok(dashboard.indexOf('/assets/frame-bridge.js')<dashboard.indexOf('window.HWSync ='));
  assert.ok(!dashboard.includes('https://cdnjs.cloudflare.com/'));
  assert.ok(!dashboard.includes('@import url(\'https://fonts.googleapis.com'));
  for(const file of ['mobile-runtime.js','mobile-ui.js','mobile.css','frame-bridge.js','html2canvas.min.js'])assert.ok(fs.existsSync(path.join(root,'www/assets',file)));
});
test('automatic PC sync and folder backups are disabled only in the mobile build',()=>{
  assert.ok(dashboard.includes('function autoSyncOn(){ return false; }'));
  assert.ok(dashboard.includes('function autoBackupOn(){ return false; }'));
});
test('all packaged inline scripts and mobile JavaScript parse',()=>{
  for(const [name,html] of [['shell',shell],['dashboard',dashboard]]){
    for(const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)){
      if(/\bsrc=|application\/json/.test(m[1]||''))continue;
      if(/text\/plain/.test(m[1]||'')&&!/id="child-shim"/.test(m[1]||''))continue;
      new vm.Script(m[2],{filename:name});
    }
  }
  for(const file of ['mobile-ui.js','frame-bridge.js','mobile-runtime.js'])new vm.Script(fs.readFileSync(path.join(root,'www/assets',file),'utf8'),{filename:file});
});
test('native app bundles web assets and refuses cleartext or Android backup',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'capacitor.config.json'),'utf8'));
  assert.equal(config.server.url,undefined);assert.equal(config.server.cleartext,false);
  const manifest=fs.readFileSync(path.join(root,'android/app/src/main/AndroidManifest.xml'),'utf8');
  assert.ok(manifest.includes('android:allowBackup="false"'));assert.ok(manifest.includes('android:usesCleartextTraffic="false"'));
});
