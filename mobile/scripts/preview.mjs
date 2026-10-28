// Local, synthetic preview only. This server never contacts the live service.
// Nothing in this file or its sample records is included in the Android APK.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../www');
const port=Number(process.env.PORT||4178);
const user={id:1,email:'admin@example.test',name:'Demo Admin',role:'admin',org_id:1,is_active:true};
const employees=['Asha Demo','Ravi Demo','Neha Demo','Dev Demo'].map((name,i)=>({name,code:String(i+1),shift:'9:30-6:30',is_active:true}));
const now=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
const ym=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
const date=ym+'-'+String(now.getDate()).padStart(2,'0');
const records=[];
for(let day=1;day<=now.getDate();day++){
  const d=ym+'-'+String(day).padStart(2,'0');
  if(new Date(d+'T12:00:00').getDay()===0)continue;
  employees.forEach((e,i)=>records.push({e:e.name,d,in:i===1?'10:02':'09:27',out:'18:34',dur:i===1?'7:45':'8:02',c:3,st:'PR'}));
}
const values={
  companyInfo:JSON.stringify({name:'Homeweavers · Demo',address:'Sample records only'}),
  salaries:JSON.stringify(Object.fromEntries(employees.map((e,i)=>[e.name,35000+i*5000]))),
  joinDates:JSON.stringify(Object.fromEntries(employees.map(e=>[e.name,'2026-01-01']))),
  officialLeaves:JSON.stringify({[ym+'-02']:{name:'Sample company holiday',note:'Office closed'}}),
  leaveRequests:JSON.stringify([{id:'demo-request-1',empName:'Asha Demo',dateFrom:date,dateTo:date,leaveType:'CL',status:'pending',message:'Sample leave request',createdAt:new Date().toISOString()}]),
  dailyTasks:'{}',overrides:'{}',halfDays:'{}',lockedMonths:'{}'
};
const versions=Object.fromEntries(Object.keys(values).map(k=>[k,1]));
let signedIn=true,activeUser=user,changes=[],cursor=0;
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://127.0.0.1');
    if(u.pathname==='/phone'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end('<!doctype html><html><head><title>HW Admin · phone preview</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#e5eaf0;display:flex;align-items:center;flex-direction:column;font-family:system-ui;padding:12px}p{font-size:12px;color:#4d6179;margin:4px 0 12px}iframe{border:1px solid #cbd5e1;background:#fff;width:min(100%,430px);height:calc(100dvh - 58px);border-radius:20px;box-shadow:0 12px 40px #142b4612}</style></head><body><p>Super Admin · Phone preview · Sample data only</p><iframe src="/" title="Android app preview"></iframe></body></html>');return;
    }
    if(u.pathname==='/healthz')return json(res,{ok:true});
    if(u.pathname.startsWith('/api/')){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      if(u.pathname==='/api/login'){
        signedIn=true;
        activeUser=body.email==='employee@example.test'?{...user,id:2,role:'employee'}:body.email==='viewer@example.test'?{...user,id:3,role:'admin_view'}:user;
        return json(res,{user:activeUser});
      }
      if(u.pathname==='/api/logout'){signedIn=false;return json(res,{ok:true});}
      if(u.pathname==='/api/client-errors'){if(req.method==='POST')console.log('Preview client error:',body.message);return json(res,{ok:true});}
      if(!signedIn)return json(res,{error:'not_authenticated'},401);
      if(u.pathname==='/api/me')return json(res,{user:activeUser});
      if(u.pathname==='/api/kv-all')return json(res,{values,versions});
      if(u.pathname.startsWith('/api/kv/')){
        const key=decodeURIComponent(u.pathname.slice(8));
        if(req.method==='PUT'){
          if(body.baseVersion!=null&&body.baseVersion!==(versions[key]||0))return json(res,{error:'version_conflict'},409);
          values[key]=body.value;versions[key]=(versions[key]||0)+1;
          changes.push({id:++cursor,kind:'kv',key,changed_by:1});return json(res,{ok:true,version:versions[key]});
        }
        return json(res,Object.hasOwn(values,key)?{key,value:values[key],version:versions[key]||0,shared:true}:null);
      }
      if(u.pathname==='/api/kv')return json(res,{keys:Object.keys(values)});
      if(u.pathname==='/api/dataset')return json(res,{employees,records});
      if(u.pathname==='/api/changes')return json(res,{changes:changes.filter(c=>c.id>Number(u.searchParams.get('since')||0)),cursor,self:1});
      if(u.pathname==='/api/users')return json(res,{users:[user,...employees.map((e,i)=>({id:i+2,name:e.name,email:'demo'+i+'@example.test',role:'employee',is_active:true}))]});
      if(u.pathname==='/api/two-step')return json(res,{enabled:false});
      if(u.pathname==='/api/employees/left')return json(res,{employees:[]});
      if(u.pathname==='/api/history')return json(res,{history:[]});
      if(u.pathname==='/api/mail/log')return json(res,{logs:[]});
      if(u.pathname==='/api/mail')return json(res,{configured:false,config:{}});
      if(u.pathname.startsWith('/api/mail/'))return json(res,{error:'Email is disabled in the local demo'},400);
      if(u.pathname==='/api/status')return json(res,{ok:true,db:{ok:true},usage:{bytes:0,limit:5368709120}});
      return json(res,{ok:true});
    }
    let rel=decodeURIComponent(u.pathname);if(rel==='/')rel='/index.html';
    const filename=path.resolve(root,'.'+rel);
    if(!filename.startsWith(root+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(filename)]||'application/octet-stream','cache-control':'no-store'});
    fs.createReadStream(filename).pipe(res);
  }catch(error){json(res,{error:String(error.message)},500);}
});
server.listen(port,'127.0.0.1',()=>console.log('Synthetic mobile preview: http://127.0.0.1:'+port+'/phone'));
