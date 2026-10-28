(function(){
  'use strict';
  document.body.classList.add('hw-mobile');
  const admin = document.getElementById('adminView');
  const content = document.querySelector('.att-content');
  if (!admin || !content) return;
  const names = {dashboard:'Overview',attendance:'Attendance',requests:'Requests',salary:'Payroll',leave:'Leave balances',worklog:'Work log',holidays:'Company holidays',backup:'Backup & restore',users:'Users & access',more:'More'};
  const originalTabs = new Map([...document.querySelectorAll('#pageTabs .page-tab')].map(el=>[el.dataset.page,el]));
  let page = 'dashboard', more = false, booted = false, chosenDate = '';
  const head = document.createElement('header'); head.className = 'mobile-page-head';
  head.innerHTML = '<div><span class="mobile-eyebrow">SUPER ADMIN</span><h1>Overview</h1><p>Team attendance, in one place</p></div><button class="mobile-refresh" type="button" aria-label="Refresh attendance">↻</button>';
  head.querySelector('button').onclick = function(){ if(confirm('Reload the latest data? Finish any open edits first.')) parent.HWMobile.reconnect(); };
  content.prepend(head);
  const toolbar = content.querySelector('.toolbar');
  const tools = document.createElement('details'); tools.className = 'mobile-tools';
  tools.innerHTML = '<summary>Filters & tools</summary>'; head.after(tools);
  if (toolbar) tools.appendChild(toolbar);
  const search = document.getElementById('searchBox');
  if (search && toolbar) {toolbar.prepend(search);search.placeholder='Search employees';search.setAttribute('aria-label','Search employees');}

  const paths = {
    dashboard:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    attendance:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5"/>',
    requests:'<path d="M5 3h14v18H5zM8 8h8m-8 4h5m-5 4h8"/>',
    salary:'<rect x="2" y="5" width="20" height="15" rx="3"/><path d="M2 9h20m-6 5h3"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
  };
  const nav = document.createElement('nav'); nav.id='mobileNav';nav.setAttribute('aria-label','Main navigation');
  Object.keys(paths).forEach(key=>{
    const b=document.createElement('button');b.type='button';b.dataset.mobilePage=key;
    b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+paths[key]+'</svg><span>'+names[key]+'</span>';
    b.onclick=()=>navigate(key);nav.appendChild(b);
  });
  admin.appendChild(nav);
  const menu=document.createElement('section');menu.id='mobileMore';menu.setAttribute('aria-label','More admin tools');
  const items=[['leave','◷','Leave balances','Entitlements, usage and deductions'],['worklog','≡','Work log','What the team worked on'],['holidays','☀','Company holidays','Manage the company calendar'],['users','♙','Users & access','Accounts and sign-in security'],['backup','⇅','Backup & restore','Imports, exports and email history']];
  items.forEach(([key,icon,title,description])=>{
    const b=document.createElement('button');b.type='button';b.className='mobile-menu-item';
    b.innerHTML='<span class="menu-symbol">'+icon+'</span><span><b>'+title+'</b><small>'+description+'</small></span><span class="chevron">›</span>';
    b.onclick=()=>navigate(key);menu.appendChild(b);
  });
  const version=document.createElement('p');version.className='mobile-version';version.textContent='HW Attendance Admin · 1.0.0';menu.appendChild(version);content.appendChild(menu);
  function navigate(key){
    if(key==='users'){originalTabs.get('users')?.click();return;}
    more=key==='more';page=key;menu.classList.toggle('on',more);tools.hidden=!['dashboard','attendance','leave'].includes(key);
    if(more) document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'));
    else originalTabs.get(key)?.click();
    head.querySelector('h1').textContent=names[key]||'Attendance';
    head.querySelector('p').textContent=more?'Your workspace tools and settings':key==='attendance'?'Daily records for the whole team':(document.getElementById('monthBtnLabel')?.textContent || 'Team attendance, in one place');
    nav.querySelectorAll('button').forEach(b=>{const active=b.dataset.mobilePage===key||(b.dataset.mobilePage==='more'&&!['dashboard','attendance','requests','salary'].includes(key));if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    tools.open=false;window.scrollTo({top:0});
    if(key==='salary') decoratePayroll();
  }
  // Phone cards mirror the existing rendered cells, including manual marks,
  // holidays and part-days. Opening one invokes the original day editor.
  const attPage=document.getElementById('page-attendance');
  const att=document.createElement('section');att.id='mobileAttendance';
  att.innerHTML='<div class="mobile-dates"><button type="button" aria-label="Previous day">‹</button><input type="date" aria-label="Attendance date"><button type="button" aria-label="Next day">›</button><button type="button">Today</button></div><div class="mobile-att-summary"><span></span><button type="button">Full month table</button></div><div id="mobilePeople"></div>';
  attPage.prepend(att);
  const dateInput=att.querySelector('input'); const people=att.querySelector('#mobilePeople'); const table=document.getElementById('attTable');
  function today(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const part=t=>parts.find(p=>p.type===t).value;return part('year')+'-'+part('month')+'-'+part('day');}
  function dates(){return [...new Set([...table.querySelectorAll('td[data-date]')].map(c=>c.dataset.date))].sort();}
  function move(delta){const all=dates();const i=all.indexOf(chosenDate);chosenDate=all[Math.max(0,Math.min(all.length-1,i+delta))]||'';renderPeople();}
  dateInput.onchange=()=>{chosenDate=dateInput.value;renderPeople();};
  const dateButtons=att.querySelectorAll('.mobile-dates button');dateButtons[0].onclick=()=>move(-1);dateButtons[1].onclick=()=>move(1);dateButtons[2].onclick=()=>{chosenDate=today();renderPeople();};
  att.querySelector('.mobile-att-summary button').onclick=function(){const on=attPage.classList.toggle('mobile-table-mode');this.textContent=on?'Daily staff cards':'Full month table';};
  function addText(parent,tag,text,cls){const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=text;parent.appendChild(el);return el;}
  function renderPeople(){
    const all=dates();people.replaceChildren();
    if(!all.includes(chosenDate))chosenDate=all.includes(today())?today():all.filter(d=>d<=today()).pop()||all[0]||'';
    dateInput.value=chosenDate;dateInput.min=all[0]||'';dateInput.max=all[all.length-1]||'';dateInput.disabled=!all.length;
    dateButtons[0].disabled=all.indexOf(chosenDate)<=0;dateButtons[1].disabled=all.indexOf(chosenDate)>=all.length-1;
    const groups=new Map();
    table.querySelectorAll('td[data-emp][data-date]').forEach(cell=>{if(cell.dataset.date!==chosenDate)return;const list=groups.get(cell.dataset.emp)||[];list.push(cell);groups.set(cell.dataset.emp,list);});
    att.querySelector('.mobile-att-summary span').textContent=groups.size+' employees · India time';
    if(!groups.size){addText(people,'div','No attendance to show for this selection. Choose a month or adjust the employee filters.','mobile-empty');return;}
    groups.forEach((cells,name)=>{
      const card=document.createElement('button');card.type='button';card.className='mobile-person';card.setAttribute('aria-label','Open attendance for '+name+' on '+chosenDate);card.onclick=()=>cells[0].click();
      const top=addText(card,'div','','mobile-person-top');addText(top,'span',name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase(),'mobile-avatar');
      const who=addText(top,'div','');addText(who,'h3',name);addText(who,'small','Tap to view or correct');
      let status=cells.length===1?cells[0].textContent.trim():'Present';
      if(cells.length>1 && cells.some(c=>/late/.test(c.className)))status='Late';
      const part=cells.find(c=>c.querySelector('.daypart-badge,.part-badge'));if(part)status=part.textContent.trim();
      const muted=status==='—'||/Weekly Off|Absent/.test(status);addText(top,'span',status==='—'?'No record':status,'mobile-status'+(muted?' muted':/Late|Leave|leave/.test(status)?' warning':''));
      if(cells.length>1){const values=addText(card,'div','','mobile-person-values');['In','Out','Total'].forEach((label,i)=>{const box=addText(values,'div','');addText(box,'span',label);addText(box,'strong',cells[i]?.textContent.trim()||'—');});const detail=cells.map(c=>c.title).filter(Boolean).filter(t=>!t.startsWith('How many')).join(' · ');if(detail)addText(card,'div',detail,'mobile-person-note');}
      else if(cells[0].title)addText(card,'div',cells[0].title,'mobile-person-note');people.appendChild(card);
    });
  }
  let renderTimer;
  new MutationObserver(()=>{clearTimeout(renderTimer);renderTimer=setTimeout(renderPeople,80);}).observe(table,{childList:true,subtree:true,characterData:true});
  function decoratePayroll(){
    document.querySelectorAll('.pay-table').forEach(t=>{const headers=[...t.querySelectorAll('thead th')].map(th=>th.textContent.trim());t.querySelectorAll('tbody tr').forEach(tr=>[...tr.children].forEach((cell,i)=>{if(headers[i])cell.dataset.mobileLabel=headers[i];}));});
  }
  new MutationObserver(decoratePayroll).observe(document.getElementById('salaryWrap'),{childList:true,subtree:true});
  function decorateComparison(){
    const wrap=document.getElementById('dashWrap');
    const source=wrap.querySelector('table.dash-table');
    if(!source||source.dataset.mobileReady)return;
    source.dataset.mobileReady='1';
    const labels=[...source.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    const list=document.createElement('div');list.className='mobile-compare-list';
    source.querySelectorAll('tbody tr').forEach(row=>{
      const cells=[...row.cells];const person=row.querySelector('.ed-open');if(!person)return;
      const card=document.createElement('details');card.className='mobile-compare-person';
      const summary=addText(card,'summary','');
      addText(summary,'span',cells[3]?.childNodes[0]?.textContent.trim()||cells[3]?.textContent.trim()||'—','mobile-score');addText(summary,'b',person.textContent.trim());
      const metrics=addText(card,'div','','mobile-compare-metrics');
      cells.forEach((cell,i)=>{if(i<4)return;const item=addText(metrics,'div','');addText(item,'small',labels[i]||'Details');addText(item,'span',cell.textContent.trim());});
      const open=addText(metrics,'button','Open employee details');open.type='button';open.onclick=()=>person.click();list.appendChild(card);
    });
    const scroller=source.closest('.table-scroll');scroller.style.display='none';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='mobile-compare-toggle';toggle.textContent='Full comparison table';
    toggle.onclick=()=>{const full=scroller.style.display==='none';scroller.style.display=full?'':'none';list.hidden=full;toggle.textContent=full?'Employee cards':'Full comparison table';};
    scroller.before(toggle,list);
  }
  new MutationObserver(decorateComparison).observe(document.getElementById('dashWrap'),{childList:true,subtree:true});
  const reqBadge=document.getElementById('reqBadge');
  if(reqBadge)new MutationObserver(()=>{let badge=nav.querySelector('.nav-count');const n=parseInt(reqBadge.textContent)||0;if(!n){badge?.remove();return;}if(!badge){badge=addText(nav.querySelector('[data-mobile-page=requests]'),'span','','nav-count');}badge.textContent=n;}).observe(reqBadge,{childList:true,characterData:true,subtree:true});
  // Only PC-local integrations are omitted. Refresh and server-backed import
  // and export remain available; no attempt is made to contact phone localhost.
  ['syncNowBtn','updFolderOpt','autoSyncRow','syncDaysRow','updFolderNote','impDirCard','bkDirPick','bkDirReconnect','bkDirForget','autoBackupShotChk'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.add('mobile-pc-only');});
  const backup=document.getElementById('page-backup');const note=document.createElement('p');note.className='mobile-pc-note';note.textContent='Biometric attendance is uploaded by the office PC. This app reads the shared server records. Folder watching runs on the PC; on Android, use file import or share an export.';backup.prepend(note);
  const dateLabel=document.querySelector('#impDirCard')?.parentElement;if(dateLabel)dateLabel.classList.add('mobile-pc-only');
  window.HWMobileUI={navigate,back:function(){
    for(const id of ['dofClose','slipCloseBtn','pastFormClose','modalClose','edClose','lvClose']){const b=document.getElementById(id);if(b&&b.offsetParent!==null){b.click();return true;}}
    const openTools=tools.open;if(openTools){tools.open=false;return true;}
    if(page!=='dashboard'){navigate('dashboard');return true;}return false;
  }};
  function start(){if(booted||getComputedStyle(admin).display==='none')return;booted=true;renderPeople();navigate('dashboard');}
  new MutationObserver(start).observe(admin,{attributes:true,attributeFilter:['style','class']});start();
})();
