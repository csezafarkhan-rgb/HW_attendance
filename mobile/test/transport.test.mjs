import test from 'node:test';
import assert from 'node:assert/strict';
import {apiURL,nativeOptions,safeFilename,API_ORIGIN} from '../src/transport.mjs';
test('relative and first-party API calls resolve to the shared attendance server',()=>{
  assert.equal(apiURL('/api/kv/leaveRequests?shared=true'),API_ORIGIN+'/api/kv/leaveRequests?shared=true');
  assert.equal(apiURL('https://localhost/api/me'),API_ORIGIN+'/api/me');
  assert.equal(apiURL(API_ORIGIN+'/api/login'),API_ORIGIN+'/api/login');
});
test('native authentication is never used for third parties, assets or PC localhost',()=>{
  for(const u of ['https://evil.example/api/me','https://attendance.homeweavers.net.evil.example/api/me','http://attendance.homeweavers.net/api/me','http://127.0.0.1:8765/sync','/assets/mobile.css','blob:https://localhost/a','data:text/plain,hi','//evil.example/api/login'])assert.equal(apiURL(u),null,u);
});
test('native JSON writes preserve versions and forbid cookie injection',()=>{
  const o=nativeOptions(API_ORIGIN+'/api/kv/salaries',{method:'PUT',headers:{'content-type':'application/json',Cookie:'secret'},body:JSON.stringify({value:'{}',baseVersion:7})});
  assert.deepEqual(o.data,{value:'{}',baseVersion:7});assert.equal(o.headers.cookie,undefined);assert.equal(o.disableRedirects,true);assert.equal(o.method,'PUT');
});
test('malformed bodies fail before a network mutation',()=>{
  assert.throws(()=>nativeOptions(API_ORIGIN+'/api/kv/a',{headers:{'content-type':'application/json'},body:'{oops'}));
  assert.throws(()=>nativeOptions(API_ORIGIN+'/api/kv/a',{body:new Uint8Array(3)}));
});
test('export filenames cannot escape the private cache directory',()=>{
  assert.equal(safeFilename('../../payroll.csv'),'payroll.csv');assert.equal(safeFilename('C:\\data\\payroll.csv'),'payroll.csv');assert.equal(safeFilename('..'),'attendance-export');assert.equal(safeFilename('export<>.csv'),'export__.csv');
});
