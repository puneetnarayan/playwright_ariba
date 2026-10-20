const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { createLookup, APP_VERSION } = require('./lookup');
const app = express();
const PORT = Number(process.env.PORT || 3030);
const OUT = path.join(__dirname, 'output');
const INPUT = path.join(__dirname, 'input');
const EXCEL_META = path.join(INPUT, 'current_excel_manifest.json');
// All recordings (capture JSON, screen frames, drafts) live in one shared folder, e.g. C:\Portable_ARIBA_Files\recordings.
const REC = process.env.PORTABLE_ARIBA_FILES ? path.join(process.env.PORTABLE_ARIBA_FILES, 'recordings') : path.join(OUT, 'recordings');
fs.mkdirSync(OUT, {recursive:true});
fs.mkdirSync(REC, {recursive:true});
// One-time move of recordings that an older version left in this app's output folder.
try{for(const n of fs.readdirSync(OUT)){if(!/(_workflow_capture\.json|_frames|_playwright_workflow_draft\.js)$/.test(n))continue;const dest=path.join(REC,n);if(!fs.existsSync(dest)){fs.cpSync(path.join(OUT,n),dest,{recursive:true});}fs.rmSync(path.join(OUT,n),{recursive:true,force:true});}}catch(e){console.log('Recording migration skipped: '+e.message);}
fs.mkdirSync(INPUT, {recursive:true});
app.use(express.json({limit:'24mb'}));
app.use(express.static(path.join(__dirname,'public')));
function excelCurrent(){try{return JSON.parse(fs.readFileSync(EXCEL_META,'utf8'));}catch{return null;}}
app.get('/api/excel/current',(_req,res)=>{const data=excelCurrent();res.json({ok:true,workbook:data});});
app.post('/api/excel/upload',(req,res)=>{try{
 const name=String(req.body?.name||'workbook.xlsx').replace(/[\\/]/g,'_').slice(0,180);
 const ext=path.extname(name).toLowerCase();
 if(!['.xlsx','.xls','.csv'].includes(ext))return res.status(400).json({error:'Please drop an .xlsx, .xls, or .csv file.'});
 const encoded=String(req.body?.data||'').replace(/^data:[^,]*;base64,/,'');
 if(!encoded)return res.status(400).json({error:'The uploaded file was empty.'});
 const buffer=Buffer.from(encoded,'base64');
 if(buffer.length>15*1024*1024)return res.status(413).json({error:'File is larger than the 15 MB limit.'});
 const workbook=XLSX.read(buffer,{type:'buffer',cellDates:false});
 if(!workbook.SheetNames.length)return res.status(400).json({error:'No worksheet was found in this file.'});
 const safeName=Date.now()+'_'+name.replace(/[^a-zA-Z0-9._-]/g,'_');
 fs.writeFileSync(path.join(INPUT,safeName),buffer);
 const sheets=workbook.SheetNames.map(sheetName=>{const sheet=workbook.Sheets[sheetName];const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,blankrows:false});const cleanRows=rows.filter(row=>row.some(cell=>String(cell??'').trim()!==''));return {name:sheetName,rowCount:Math.max(0,cleanRows.length-(/^\d{6,}$/.test(String(cleanRows[0]?.[0]??'').trim())?0:1)),columnCount:cleanRows.reduce((m,r)=>Math.max(m,r.length),0),headers:(cleanRows[0]||[]).map((v,i)=>String(v||('Column '+(i+1))).trim()),preview:cleanRows.slice(0,6).map(row=>row.map(v=>String(v??'').slice(0,300))),totalNonEmptyRows:cleanRows.length};});
 const first=sheets[0];const meta={ok:true,fileName:name,storedFile:safeName,uploadedAt:new Date().toISOString(),sizeBytes:buffer.length,sheetNames:workbook.SheetNames,sheets,selectedSheet:first?.name||'',totalDataRows:sheets.reduce((n,x)=>n+x.rowCount,0),status:'Loaded for review; automation has not been run.'};
 fs.writeFileSync(EXCEL_META,JSON.stringify(meta,null,2));res.json({ok:true,workbook:meta});
 }catch(e){res.status(400).json({error:'Could not read this workbook: '+e.message});}});
app.post('/api/excel/select-sheet',(req,res)=>{try{const meta=excelCurrent();if(!meta)return res.status(404).json({error:'Upload a workbook first.'});const name=String(req.body?.sheetName||'');const sheetMeta=meta.sheets.find(s=>s.name===name);if(!sheetMeta)return res.status(404).json({error:'Worksheet not found.'});const workbook=XLSX.readFile(path.join(INPUT,meta.storedFile),{cellDates:false});const rows=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,defval:'',raw:false,blankrows:false}).filter(row=>row.some(cell=>String(cell??'').trim()!==''));sheetMeta.headers=(rows[0]||[]).map((v,i)=>String(v||('Column '+(i+1))).trim());sheetMeta.preview=rows.slice(0,6).map(row=>row.map(v=>String(v??'').slice(0,300)));meta.selectedSheet=name;meta.totalDataRows=meta.sheets.reduce((n,x)=>n+x.rowCount,0);fs.writeFileSync(EXCEL_META,JSON.stringify(meta,null,2));res.json({ok:true,workbook:meta});}catch(e){res.status(500).json({error:e.message});}});

let browser=null, context=null, page=null, recording=false, actions=[], navigations=[], markers=[];
let recordingName='', recordingFileStem='', recordingStartedAt='', recordingStoppedAt='', recordingInspections=[];
let screenFrames=[], frameDirectory='', frameCounter=0, frameCaptureTasks=[], frameCaptureQueue=Promise.resolve(), frameCaptureTimer=null;
async function takeScreenFrame(kind='event', sequenceNo=0){
 if(!page||page.isClosed()||!frameDirectory)return null;
 if(kind==='interval'&&screenFrames.filter(f=>f.kind==='interval').length>=600)return null;
 const targetPage=page;
 const task=frameCaptureQueue.then(async()=>{
  if(targetPage.isClosed())return null;
  await targetPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))).catch(()=>{});
  fs.mkdirSync(frameDirectory,{recursive:true});
  frameCounter++;
  const filename='frame_'+String(frameCounter).padStart(5,'0')+'.jpg';
  const absolute=path.join(frameDirectory,filename);
  await targetPage.screenshot({path:absolute,type:'jpeg',quality:58,timeout:8000,animations:'disabled'});
  const relative=path.relative(REC,absolute).split(path.sep).join('/');
  const frame={time:stamp(),kind,sequenceNo:Number(sequenceNo||actions.length||0),url:targetPage.url(),file:relative};
  screenFrames.push(frame);
  if(sequenceNo){const action=actions.find(a=>a.sequenceNo===Number(sequenceNo));if(action&&!action.screenFrame)action.screenFrame=relative;}
  return frame;
 }).catch(()=>null);
 frameCaptureQueue=task.then(()=>undefined,()=>undefined);
 frameCaptureTasks.push(task);
 return task;
}
function componentCounts(items, key){const counts={};for(const item of items||[]){const value=String(item?.[key]||'unknown').trim()||'unknown';counts[value]=(counts[value]||0)+1;}return counts;}
function captureData(){return {recordingName,recordingFileStem,startedAt:recordingStartedAt,stoppedAt:recordingStoppedAt||null,exportedAt:stamp(),readOnlyMode:true,navigations,actions,screenFrames,decisionMarkers:markers,inspections:recordingInspections,pageSnapshots:snapshots,componentSummary:{inspected:recordingInspections.reduce((n,x)=>n+(x.componentCount||0),0),inspectedByType:recordingInspections.reduce((all,x)=>{for(const [k,v] of Object.entries(x.byType||{}))all[k]=(all[k]||0)+v;return all;},{}),used:actions.filter(a=>a.tag).length,usedByType:componentCounts(actions.filter(a=>a.tag),'tag'),actionsByKind:componentCounts(actions,'kind')},notes:['Observation log only; not production automation.','Selectors are candidates and must be validated.','Credentials are not included in exports.','Page components, tables and visible text are captured automatically in pageSnapshots after each step; session keys (awssk) are redacted in saved files.','Read-only browser guard cannot guarantee every portal action is harmless.']};}
function saveCapture(){if(!recordingFileStem)return null;const f=path.join(REC,recordingFileStem+'_workflow_capture.json');fs.writeFileSync(f,redact(JSON.stringify(captureData(),null,2)));return f;}
const stamp=()=>new Date().toISOString();
const fileStamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
const safeSlug=s=>String(s||'PR_Workflow').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70)||'PR_Workflow';
const guardScript = `(() => {
 if (window.__prInspectorGuard) return; window.__prInspectorGuard=true;
 const clean=s=>String(s||'').replace(/\\s+/g,' ').trim().slice(0,180);
 const selector=el=>{if(el.id)return '#'+CSS.escape(el.id);let t=el.getAttribute('data-testid');if(t)return '[data-testid="'+CSS.escape(t)+'"]';let n=el.getAttribute('name');if(n)return el.tagName.toLowerCase()+'[name="'+CSS.escape(n)+'"]';let a=el.getAttribute('aria-label');if(a)return el.tagName.toLowerCase()+'[aria-label="'+CSS.escape(a)+'"]';let p=el.getAttribute('placeholder');if(p)return el.tagName.toLowerCase()+'[placeholder="'+CSS.escape(p)+'"]';let txt=clean(el.innerText||el.value);if(txt&&(el.tagName==='BUTTON'||el.tagName==='A'))return el.tagName.toLowerCase()+' text='+JSON.stringify(txt);let parts=[],node=el;while(node&&node.nodeType===1&&node!==document.body&&parts.length<6){if(node.id){parts.unshift('#'+CSS.escape(node.id));break}const tag=node.tagName.toLowerCase(),siblings=Array.from(node.parentElement?.children||[]).filter(x=>x.tagName===node.tagName),idx=siblings.indexOf(node)+1;parts.unshift(tag+':nth-of-type('+idx+')');node=node.parentElement}return parts.join(' > ')||el.tagName.toLowerCase()};
 const risky=el=>{let tag=(el.tagName||'').toLowerCase(), txt=clean((el.innerText||el.value||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')).toLowerCase(), href=(el.getAttribute('href')||'').toLowerCase(); if(/\\b(approve|release pr|release requisition|reject|delete|remove|save changes|submit request|submit pr|post document|confirm release|finalize|withdraw|cancel request)\\b/.test(txt)||/\\b(approve|release|reject|delete|post|finalize)\\b/.test(href))return true; if(tag==='button'&&el.type==='submit'){if(/\\b(log ?in|sign ?in|authenticate|continue)\\b/.test(txt)&&document.querySelector('input[type=\"password\"]'))return false;return !/\\b(search|find|filter|display|show|lookup|go)\\b/.test(txt)} if((tag==='button'||el.getAttribute('role')==='button')&&/\\b(log ?in|sign ?in|authenticate)\\b/.test(txt)&&document.querySelector('input[type=\"password\"]'))return false; return false};
 document.addEventListener('click',ev=>{let el=ev.target?.closest?.('button,a,input,select,[role="button"],[role="menuitem"]');if(!el)return;let blocked=risky(el);try{(()=>{const b=el.getBoundingClientRect();window.__prEvent?.({kind:'click',time:new Date().toISOString(),tag:el.tagName.toLowerCase(),text:clean(el.innerText||el.value||el.getAttribute('aria-label')),selector:selector(el),url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height},blocked,note:blocked?'Potentially state-changing action blocked by read-only guard':''})})()}catch(e){} if(blocked){ev.preventDefault();ev.stopImmediatePropagation();ev.stopPropagation()}},true);
 document.addEventListener('change',ev=>{let el=ev.target;if(!el||!['INPUT','SELECT','TEXTAREA'].includes(el.tagName))return;let type=(el.type||'').toLowerCase(),value='',loginPage=!!document.querySelector('input[type=\"password\"]');if(loginPage)value='[REDACTED LOGIN FIELD]';else if(type==='password')value='[REDACTED]';else if(type==='checkbox'||type==='radio')value=el.checked?(el.value||'checked'):'unchecked';else if(el.tagName==='SELECT')value=el.options[el.selectedIndex]?.text||'';else value=String(el.value||'').slice(0,120);try{(()=>{const b=el.getBoundingClientRect();window.__prEvent?.({kind:'change',time:new Date().toISOString(),tag:el.tagName.toLowerCase(),field:el.name||el.id||el.getAttribute('aria-label')||el.placeholder||'',selector:selector(el),value,url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height}})})()}catch(e){}},true);
 document.addEventListener('submit',ev=>{let label=String(ev.submitter?.innerText||ev.submitter?.value||ev.submitter?.getAttribute('aria-label')||'').toLowerCase();if(/\\b(log ?in|log ?on|sign ?in|authenticate|continue)\\b/.test(label)&&document.querySelector('input[type=\"password\"]'))return;if(!/\\b(search|find|filter|display|show|lookup|go)\\b/.test(label)){try{window.__prEvent?.({kind:'blocked-submit',time:new Date().toISOString(),url:location.href,text:label||'(unnamed form submit)',blocked:true,note:'Form submission blocked by read-only guard'})}catch(e){}ev.preventDefault();ev.stopImmediatePropagation();ev.stopPropagation()}},true);
})();`;
const visualScript = `(() => {
 if (window.__prVisualInspectorInstalled) return; window.__prVisualInspectorInstalled=true;
 const clean=s=>String(s||'').replace(/\\s+/g,' ').trim().slice(0,180);
 const palette={button:'#dbeafe',a:'#dcfce7',input:'#fef3c7',select:'#f3e8ff',textarea:'#ffedd5',table:'#cffafe',td:'#cffafe',th:'#cffafe',label:'#fce7f3',div:'#e2e8f0',span:'#e2e8f0',other:'#e0e7ff'};
 const color=tag=>palette[String(tag||'other').toLowerCase()]||palette.other;
 const sel=el=>{if(!el)return '';if(el.id)return '#'+CSS.escape(el.id);for(const a of ['data-testid','name','aria-label','placeholder']){const v=el.getAttribute?.(a);if(v)return el.tagName.toLowerCase()+'['+a+'="'+CSS.escape(v)+'"]'}let parts=[],node=el;while(node&&node.nodeType===1&&node!==document.body&&parts.length<6){if(node.id){parts.unshift('#'+CSS.escape(node.id));break}const tag=node.tagName.toLowerCase(),siblings=Array.from(node.parentElement?.children||[]).filter(x=>x.tagName===node.tagName),idx=siblings.indexOf(node)+1;parts.unshift(tag+':nth-of-type('+idx+')');node=node.parentElement}return parts.join(' > ')||el.tagName?.toLowerCase()||'unknown'};
 const root=()=>{let r=document.getElementById('__prVisualOverlay');if(r)return r;r=document.createElement('div');r.id='__prVisualOverlay';r.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden';(document.documentElement||document.body).appendChild(r);return r};
 let localSeq=0, hoverTimer=null, hoverEl=null;
 const draw=(el,kind,seq,text,keepCircle=true)=>{if(!el||!el.getBoundingClientRect)return;const b=el.getBoundingClientRect();if(b.width<=0||b.height<=0)return;const r=root();let old=document.getElementById('__prCurrentHighlight');if(old)old.remove();const box=document.createElement('div');box.id='__prCurrentHighlight';const c=color(el.tagName?.toLowerCase());box.style.cssText='position:fixed;left:'+Math.max(0,b.left)+'px;top:'+Math.max(0,b.top)+'px;width:'+Math.max(8,b.width)+'px;height:'+Math.max(8,b.height)+'px;border:3px solid '+(c===palette.input?'#d97706':'#2563eb')+';background:'+c+'55;border-radius:4px;box-shadow:0 0 0 2px #fff;box-sizing:border-box;';const tag=document.createElement('span');tag.textContent='#'+seq+' '+kind+' · '+el.tagName.toLowerCase();tag.style.cssText='position:absolute;left:0;top:-22px;background:'+c+';color:#172033;border:1px solid #64748b;border-radius:4px;padding:2px 5px;font:600 11px Segoe UI,Arial;white-space:nowrap;';box.appendChild(tag);r.appendChild(box);if(keepCircle&&(kind.toLowerCase().includes('click')||kind.toLowerCase().includes('selected'))){const dot=document.createElement('div');dot.className='__prClickCircle';dot.style.cssText='position:fixed;left:'+Math.max(0,b.left+b.width/2-17)+'px;top:'+Math.max(0,b.top+b.height/2-17)+'px;width:34px;height:34px;border-radius:50%;border:4px solid #eab308;background:#facc1555;box-shadow:0 0 0 2px white,0 0 10px #ca8a04;';const n=document.createElement('span');n.textContent=String(seq);n.style.cssText='position:absolute;inset:0;display:grid;place-items:center;color:#713f12;font:bold 12px Segoe UI,Arial';dot.appendChild(n);r.appendChild(dot)}};
 document.addEventListener('click',ev=>{const interactive=ev.target?.closest?.('button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]');const el=interactive||ev.target;if(!el||el.closest?.('#__prVisualOverlay'))return;localSeq++;const txt=clean(el.innerText||el.value||el.getAttribute?.('aria-label'));draw(el,'click',localSeq,txt);if(!interactive){const b=el.getBoundingClientRect();window.__prEvent?.({kind:'component-click',time:new Date().toISOString(),tag:el.tagName.toLowerCase(),text:txt,selector:sel(el),url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height},note:'Non-interactive page component clicked'});}},true);
 document.addEventListener('selectionchange',()=>{const selObj=window.getSelection();if(!selObj||selObj.isCollapsed)return;const text=clean(selObj.toString(),160);if(!text)return;const node=selObj.anchorNode;const el=node?.nodeType===1?node:node?.parentElement;if(!el||el.closest?.('#__prVisualOverlay'))return;const now=Date.now();if(window.__prLastSelectedText===text&&now-(window.__prLastSelectionAt||0)<1200)return;window.__prLastSelectedText=text;window.__prLastSelectionAt=now;localSeq++;draw(el,'selected text',localSeq,text,true);const b=el.getBoundingClientRect();window.__prEvent?.({kind:'text-selection',time:new Date().toISOString(),tag:el.tagName.toLowerCase(),text,selector:sel(el),url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height},note:'Text selection component captured'});},true);
 document.addEventListener('select',ev=>{const el=ev.target;if(!el||!['INPUT','TEXTAREA'].includes(el.tagName))return;const text=clean(String(el.value||'').slice(el.selectionStart||0,el.selectionEnd||0),160);if(!text)return;localSeq++;draw(el,'selected text',localSeq,text,true);const b=el.getBoundingClientRect();window.__prEvent?.({kind:'text-selection',time:new Date().toISOString(),tag:el.tagName.toLowerCase(),text,selector:sel(el),url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height},note:'Text selected inside form field'});},true);
 document.addEventListener('pointerover',ev=>{const el=ev.target?.closest?.('button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="gridcell"],td,th,label')||ev.target;if(!el||['HTML','BODY'].includes(el.tagName)||el===hoverEl||el.closest?.('#__prVisualOverlay'))return;clearTimeout(hoverTimer);hoverEl=el;hoverTimer=setTimeout(()=>{if(!hoverEl||!hoverEl.isConnected)return;localSeq++;draw(hoverEl,'hover 4s',localSeq,'',false);const b=hoverEl.getBoundingClientRect();window.__prEvent?.({kind:'hover',time:new Date().toISOString(),tag:hoverEl.tagName.toLowerCase(),text:clean(hoverEl.innerText||hoverEl.getAttribute('aria-label')),selector:sel(hoverEl),url:location.href,rect:{x:b.x,y:b.y,width:b.width,height:b.height},note:'Hovered for more than 4 seconds'});},4000)},true);
 document.addEventListener('pointerout',ev=>{if(hoverEl&&(!ev.relatedTarget||!hoverEl.contains(ev.relatedTarget))){clearTimeout(hoverTimer);hoverTimer=null;hoverEl=null}},true);
 window.__prPlaybackHighlight=(data)=>{const r=root();document.querySelectorAll('.__prPlaybackClickCircle').forEach(n=>{});let el=null;try{if(data.selector&&!data.selector.includes(' text=')&&!data.selector.includes('nth='))el=document.querySelector(data.selector)}catch{};if(!el&&data.rect){const x=data.rect.x+Math.min(data.rect.width/2,10),y=data.rect.y+Math.min(data.rect.height/2,10);el=document.elementFromPoint(x,y)}if(!el){const old=document.getElementById('__prCurrentHighlight');if(old)old.remove();const hint=document.createElement('div');hint.id='__prCurrentHighlight';hint.textContent='#'+(data.sequenceNo||'?')+' '+(data.kind||'step')+' · '+(data.text||data.selector||'component not found on current page');hint.style.cssText='position:fixed;top:12px;left:12px;max-width:70vw;background:#fef3c7;border:2px solid #eab308;color:#713f12;padding:8px 10px;border-radius:7px;font:bold 12px Segoe UI,Arial';r.appendChild(hint);return {found:false}};draw(el,data.kind||'playback',data.sequenceNo||'?',data.text||'',true);return {found:true,tag:el.tagName.toLowerCase()}};
})();`;

// ---- Page component capture (runs in the page; must not use outer variables) ----
const inspectFn=(opts)=>{
 const maxRows=(opts&&opts.maxRows)||4, textCap=(opts&&opts.textCap)||5000, noHtml=!!(opts&&opts.noHtml);
 const clean=(s,n=220)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 const esc=s=>CSS.escape(s);
 const cssPath=el=>{const parts=[];let n=el;while(n&&n.nodeType===1&&n!==document.body&&parts.length<6){if(n.id){parts.unshift('#'+esc(n.id));break}const tag=n.tagName.toLowerCase();const sib=Array.from(n.parentElement?n.parentElement.children:[]).filter(x=>x.tagName===n.tagName);parts.unshift(tag+':nth-of-type('+(sib.indexOf(n)+1)+')');n=n.parentElement}return parts.join(' > ')};
 const sel=el=>{if(el.id)return '#'+esc(el.id);for(const a of ['data-testid','name','aria-label','placeholder']){const v=el.getAttribute(a);if(v)return el.tagName.toLowerCase()+'['+a+'="'+esc(v)+'"]'}const tx=clean(el.innerText||el.value,70);if(tx&&(el.tagName==='BUTTON'||el.tagName==='A'))return el.tagName.toLowerCase()+' text='+JSON.stringify(tx);return cssPath(el)||el.tagName.toLowerCase()};
 const nodes=Array.from(document.querySelectorAll('input,select,textarea,button,a,[role="button"],[role="combobox"],[role="menuitem"],[role="tab"],[role="gridcell"],table,[role="grid"]')).slice(0,600);
 const controls=nodes.map((el,index)=>{const c={index,tag:el.tagName.toLowerCase(),type:el.type||'',role:el.getAttribute('role')||'',label:clean((el.labels&&el.labels[0]?el.labels[0].innerText:'')||el.getAttribute('aria-label')||el.placeholder||''),text:clean(el.innerText||el.value||'',130),id:el.id||'',name:el.name||'',placeholder:el.placeholder||'',visible:visible(el),enabled:!el.disabled,selector:sel(el),cssPath:cssPath(el),options:el.tagName==='SELECT'?Array.from(el.options).map(o=>({text:clean(o.text,100),value:o.value})):[]};if(el.tagName==='A'&&el.getAttribute('href'))c.href=el.getAttribute('href').slice(0,200);if(!noHtml)c.html=el.outerHTML.slice(0,300);return c});
 const tables=Array.from(document.querySelectorAll('table')).slice(0,60).map((t,index)=>{const rowsEl=Array.from(t.querySelectorAll('tr'));const rows=rowsEl.slice(0,maxRows).map(r=>({id:r.id||'',selector:r.id?'#'+esc(r.id):cssPath(r),cells:Array.from(r.children).filter(c=>/^T[DH]$/.test(c.tagName)).map(c=>clean(c.innerText,120)),links:Array.from(r.querySelectorAll('a')).slice(0,6).map(a=>({text:clean(a.innerText,80),selector:sel(a)}))}));return{index,id:t.id||'',selector:t.id?'#'+esc(t.id):cssPath(t),visible:visible(t),headings:Array.from(t.querySelectorAll('th')).map(x=>clean(x.innerText,100)),rowCount:rowsEl.length,rows,sampleRows:rows.slice(0,4).map(r=>r.cells)}});
 const headings=Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).slice(0,30).map(h=>clean(h.innerText,120));
 const visibleText=(document.body?document.body.innerText:'').split('\n').map(l=>l.replace(/[ \t]+/g,' ').trim()).filter(Boolean).join('\n').slice(0,textCap);
 return{url:location.href,title:document.title,headings,controls,tables,visibleText};
};
async function inspectAllFrames(opts){
 const p=page;let merged=null;
 for(const [fi,f] of p.frames().entries()){
  let r;try{r=await f.evaluate(inspectFn,opts);}catch{continue;}
  r.controls.forEach(c=>c.frame=fi);r.tables.forEach(t=>t.frame=fi);
  if(!merged){merged={...r,frameCount:p.frames().length};continue;}
  merged.controls.push(...r.controls);merged.tables.push(...r.tables);merged.headings.push(...r.headings);
  if(r.visibleText)merged.visibleText+='\n--- frame '+fi+': '+r.url+' ---\n'+r.visibleText;
 }
 if(!merged)throw new Error('Could not read the page.');
 return merged;
}
const redact=str=>String(str).replace(/awssk=[^&#"\\\s]+/g,'awssk=REDACTED');
let snapshots=[], lastSnapSig='', snapTimer=null, snapQueue=Promise.resolve(), snapTasks=[];
const textHash=t=>{let h=5381;for(let i=0;i<t.length;i++)h=((h<<5)+h+t.charCodeAt(i))|0;return h};
function byTypeOf(controls){const byType={};for(const c of controls){const k=[c.tag,c.type].filter(Boolean).join('/');byType[k]=(byType[k]||0)+1;}return byType;}
function storeSnapshot(result,seq,trigger){
 const byType=byTypeOf(result.controls);
 snapshots.push({time:stamp(),sequenceNo:Number(seq||actions.length||0),trigger,url:result.url,title:result.title,frameCount:result.frameCount,componentCount:result.controls.length,byType,headings:result.headings,tables:result.tables,controls:result.controls,visibleText:result.visibleText});
 recordingInspections.push({time:stamp(),url:result.url,title:result.title,componentCount:result.controls.length,byType,tables:result.tables.length,trigger});
}
// Capture all components of the current page after the page settles; skipped on login/credential pages.
function scheduleSnapshot(seq,trigger){if(!recording)return;clearTimeout(snapTimer);snapTimer=setTimeout(()=>{snapTimer=null;takeSnapshot(seq,trigger)},1000);}
function takeSnapshot(seq,trigger){
 const task=snapQueue.then(async()=>{
  const p=page;if(!p||p.isClosed()||snapshots.length>=200)return;
  try{
   if(/login\.microsoftonline\.com|login\.live\.com/i.test(p.url()))return;
   if(await p.locator('input[type="password"]:visible').count().catch(()=>0))return;
   await p.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
   const r=await inspectAllFrames({maxRows:40,textCap:20000,noHtml:true});
   const sig=r.url.replace(/awssk=[^&#]*/,'')+'|'+r.controls.length+'|'+textHash(r.visibleText);
   if(sig===lastSnapSig)return;
   lastSnapSig=sig;storeSnapshot(r,seq,trigger);
  }catch(e){if(process.env.PR_DEBUG)console.log("snapshot skipped:",e.message)}
 }).catch(()=>{});
 snapQueue=task;snapTasks.push(task);return task;
}
async function ensureBrowser(){if(browser?.isConnected()&&page&&!page.isClosed())return;browser=await chromium.launch({headless:process.env.PR_HEADLESS==='1',...(process.env.PR_CHROMIUM_PATH?{executablePath:process.env.PR_CHROMIUM_PATH,args:['--no-sandbox','--remote-debugging-port=9333']}:{})});context=await browser.newContext({viewport:{width:1440,height:950}});await context.exposeBinding('__prEvent',async(_src,p)=>{if(recording&&p&&typeof p==='object'){if(/password|token|secret/i.test(p.field||''))p.value='[REDACTED]';const action={...p,sequenceNo:actions.length+1,capturedAt:stamp()};actions.push(action);await takeScreenFrame('event',action.sequenceNo);if(!['hover','text-selection'].includes(action.kind))scheduleSnapshot(action.sequenceNo,action.kind)}});await context.addInitScript({content:guardScript});await context.addInitScript({content:visualScript});page=await context.newPage();page.on('framenavigated',frame=>{if(frame===page.mainFrame()){const nav={time:stamp(),url:frame.url(),title:''};navigations.push(nav);if(recording){const action={kind:'navigation',time:nav.time,tag:'page',text:nav.url,url:nav.url,sequenceNo:actions.length+1,capturedAt:nav.time};actions.push(action);takeScreenFrame('navigation',action.sequenceNo);scheduleSnapshot(action.sequenceNo,'navigation')}}});page.on('popup',async p=>{page=p;page.on('framenavigated',frame=>{if(frame===page.mainFrame()){const nav={time:stamp(),url:frame.url(),title:''};navigations.push(nav);if(recording){const action={kind:'navigation',time:nav.time,tag:'page',text:nav.url,url:nav.url,sequenceNo:actions.length+1,capturedAt:nav.time};actions.push(action);takeScreenFrame('navigation',action.sequenceNo);scheduleSnapshot(action.sequenceNo,'navigation')}}})})}
app.get('/api/status',(_req,res)=>res.json({browserOpen:!!(browser?.isConnected()&&page&&!page.isClosed()),recording,recordingName,recordingFileStem,actionCount:actions.length,url:page&&!page.isClosed()?page.url():''}));
app.get('/api/sequence',(_req,res)=>res.json({ok:true,recordingName,recordingFileStem,actions:actions.map((a,i)=>({...a,sequenceNo:a.sequenceNo||i+1})),screenFrames}));
app.post('/api/playback/step',async(req,res)=>{try{if(recording)return res.status(400).json({error:'Stop recording before playback.'});if(!page||page.isClosed())return res.status(400).json({error:'Open the portal in the Playwright browser first.'});const i=Number(req.body.index);if(!Number.isInteger(i)||i<0||i>=actions.length)return res.status(400).json({error:'Playback step is out of range.'});const a=actions[i];if(a.url){try{const target=new URL(a.url),current=new URL(page.url());if(target.origin===current.origin&&target.href!==current.href)await page.goto(a.url,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});}catch{}}const result=await page.evaluate((data)=>window.__prPlaybackHighlight?window.__prPlaybackHighlight(data):({found:false,reason:'Overlay not available'}),{...a,sequenceNo:a.sequenceNo||i+1});res.json({ok:true,index:i,sequenceNo:a.sequenceNo||i+1,kind:a.kind||'step',text:a.text||a.field||a.selector||a.note||'',result,total:actions.length});}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/browser/launch',async(_req,res)=>{try{await ensureBrowser();await page.bringToFront().catch(()=>{});res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/open',async(req,res)=>{try{let url=String(req.body.url||'').trim();if(!/^https?:\/\//i.test(url))return res.status(400).json({error:'Enter a full http:// or https:// URL.'});await ensureBrowser();await page.bringToFront().catch(()=>{});await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});await page.evaluate(guardScript).catch(()=>{});res.json({ok:true,url:page.url(),title:await page.title().catch(()=> '')})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/fill-login',async(req,res)=>{
 try{
  if(!page||page.isClosed())return res.status(400).json({error:'Open the portal in the Playwright browser first.'});
  const userId=String(req.body.userId||''); const password=String(req.body.password||'');
  if(!userId.trim()||!password)return res.status(400).json({error:'Enter both User ID and password in the local GUI.'});
  const fields=await page.evaluate(()=>{
   const vis=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
   const all=Array.from(document.querySelectorAll('input')).filter(e=>vis(e)&&!e.disabled);
   const pw=all.filter(e=>(e.type||'').toLowerCase()==='password');
   const hints=e=>[e.name,e.id,e.placeholder,e.getAttribute('aria-label'),e.getAttribute('autocomplete'),e.getAttribute('data-testid'),...(e.labels?Array.from(e.labels).map(l=>l.innerText):[])].filter(Boolean).join(' ').toLowerCase();
   const user=all.filter(e=>['text','email','tel',''].includes((e.type||'text').toLowerCase())&&/(user.?id|user.?name|username|login|employee.?id|network.?id|email|account)/i.test(hints(e)));
   return {passwordCount:pw.length,passwordSelector:pw.length===1?(pw[0].id?'#'+CSS.escape(pw[0].id):pw[0].name?'input[name=\"'+CSS.escape(pw[0].name)+'\"]': 'input[type=\"password\"]'):null,userCandidates:user.map(e=>({selector:e.id?'#'+CSS.escape(e.id):e.name?'input[name=\"'+CSS.escape(e.name)+'\"]':e.getAttribute('autocomplete')?'input[autocomplete=\"'+CSS.escape(e.getAttribute('autocomplete'))+'\"]':e.placeholder?'input[placeholder=\"'+CSS.escape(e.placeholder)+'\"]':null,label:e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.placeholder||e.name||e.id||''})).filter(x=>x.selector)};
  });
  if(fields.passwordCount!==1||!fields.passwordSelector)return res.status(400).json({error:`Expected exactly one visible password field; found ${fields.passwordCount}. Inspect the page and fill login manually.`});
  if(fields.userCandidates.length!==1)return res.status(400).json({error:`Could not identify exactly one User ID field (found ${fields.userCandidates.length}). Inspect the page and fill login manually.`});
  await page.locator(fields.userCandidates[0].selector).fill(userId);
  await page.locator(fields.passwordSelector).fill(password);
  // Do not log, persist, or return credentials. Clear the request body references as soon as practical.
  req.body.userId=''; req.body.password='';
  res.json({ok:true,message:`Filled login fields (${fields.userCandidates[0].label || 'User ID'} and password). Credentials are not saved or exported. Review the browser and click the portal's login button manually.`});
 }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/inspect',async(_req,res)=>{try{if(!page||page.isClosed())return res.status(400).json({error:'Open the portal in the Playwright browser first.'});const result=await inspectAllFrames({maxRows:30,textCap:20000});fs.writeFileSync(path.join(OUT,'latest_inspection.json'),redact(JSON.stringify(result,null,2)));if(recording){storeSnapshot({...result,controls:result.controls.map(({html,...c})=>c)},actions.length,'manual');lastSnapSig='';}res.json({ok:true,result,file:'output/latest_inspection.json'})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/record/start',(req,res)=>{
 let requested=String(req.body.name||'').trim();if(!requested)return res.status(400).json({error:'Enter a name for this recording before starting.'});if(recording)return res.status(400).json({error:'A recording is already active. Stop it before starting another.'});
 actions=[];navigations=[];markers=[];recordingInspections=[];screenFrames=[];frameCounter=0;frameCaptureTasks=[];frameCaptureQueue=Promise.resolve();snapshots=[];lastSnapSig='';snapTasks=[];snapQueue=Promise.resolve();clearTimeout(snapTimer);snapTimer=null;recordingName=requested.slice(0,100);recordingStartedAt=stamp();recordingStoppedAt='';recordingFileStem=safeSlug(recordingName)+'_'+fileStamp();frameDirectory=path.join(REC,recordingFileStem+'_frames');fs.mkdirSync(frameDirectory,{recursive:true});recording=true;
 if(page&&!page.isClosed()){const nav={time:stamp(),url:page.url(),title:''};navigations.push(nav);const action={kind:'navigation',time:nav.time,tag:'page',text:nav.url,url:nav.url,sequenceNo:actions.length+1,capturedAt:nav.time};actions.push(action);takeScreenFrame('start',action.sequenceNo);takeSnapshot(action.sequenceNo,'start')};
 if(frameCaptureTimer)clearInterval(frameCaptureTimer);frameCaptureTimer=setInterval(()=>{if(recording&&page&&!page.isClosed())takeScreenFrame('interval',actions.length)},2000);
 res.json({ok:true,recordingName,recordingFileStem,startedAt:recordingStartedAt,message:`Recording started: ${recordingFileStem}. Screen frames will be saved with the yellow markers.`})
});
app.post('/api/record/stop',async(_req,res)=>{const pendingSnap=!!snapTimer;clearTimeout(snapTimer);snapTimer=null;if(pendingSnap)takeSnapshot(actions.length,'stop');recording=false;if(frameCaptureTimer){clearInterval(frameCaptureTimer);frameCaptureTimer=null;}recordingStoppedAt=stamp();await Promise.allSettled(frameCaptureTasks);await Promise.allSettled(snapTasks);const savedFile=saveCapture();res.json({ok:true,recordingName,recordingFileStem,startedAt:recordingStartedAt,stoppedAt:recordingStoppedAt,savedFile:path.basename(savedFile||''),framesFolder:recordingFileStem+'_frames',frameCount:screenFrames.length,actionCount:actions.length,navigationCount:navigations.length,markerCount:markers.length,inspectionCount:recordingInspections.length})});
app.post('/api/marker',(req,res)=>{let note=String(req.body.note||'').trim().slice(0,500);if(!note)return res.status(400).json({error:'Enter a branch note.'});markers.push({time:stamp(),recordingName,recordingFileStem,url:page&&!page.isClosed()?page.url():'',note});res.json({ok:true,marker:markers.at(-1)})});
app.get('/api/export',(_req,res)=>{let stem=recordingFileStem||('PR_Workflow_'+fileStamp());let f=saveCapture();if(!f){f=path.join(REC,stem+'_workflow_capture.json');fs.writeFileSync(f,redact(JSON.stringify(captureData(),null,2)));}res.download(f)});
app.get('/api/recordings',(_req,res)=>{try{const files=fs.readdirSync(REC).filter(n=>n.endsWith('_workflow_capture.json'));const recordings=files.map(name=>{try{const d=JSON.parse(fs.readFileSync(path.join(REC,name),'utf8'));const inspectedByType=d.componentSummary?.inspectedByType||((d.inspections||[]).reduce((all,x)=>{for(const [k,v] of Object.entries(x.byType||{}))all[k]=(all[k]||0)+v;return all;},{}));const usedByType=d.componentSummary?.usedByType||componentCounts((d.actions||[]).filter(a=>a.tag),'tag');const actionsByKind=d.componentSummary?.actionsByKind||componentCounts(d.actions||[],'kind');return {file:name,name:d.recordingName||name,startedAt:d.startedAt||d.exportedAt||null,stoppedAt:d.stoppedAt||null,exportedAt:d.exportedAt||null,actionCount:(d.actions||[]).length,navigationCount:(d.navigations||[]).length,markerCount:(d.decisionMarkers||[]).length,inspectionCount:(d.inspections||[]).length,frameCount:(d.screenFrames||[]).length,inspectedCount:d.componentSummary?.inspected??Object.values(inspectedByType).reduce((a,b)=>a+b,0),inspectedByType,usedCount:d.componentSummary?.used??(d.actions||[]).filter(a=>a.tag).length,usedByType,actionsByKind};}catch{return null}}).filter(Boolean).sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));res.json({ok:true,recordings,folder:REC});}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/draft',(_req,res)=>{let lines=actions.map(a=>a.kind==='click'?`// ${a.blocked?'BLOCKED potentially mutating action':'Click observed'}: ${a.text||a.selector}\n// Candidate locator: ${a.selector||'inspect manually'}\n// URL: ${a.url||''}`:a.kind==='change'?`// Field changed: ${a.field||a.selector}; observed value: ${/password|token|secret/i.test(a.field||'')?'[REDACTED]':a.value}\n// Candidate locator: ${a.selector||'inspect manually'}`:`// ${a.kind}: ${a.note||a.text||''}`).join('\n\n');let draft=`// Candidate Playwright draft. Review and validate all selectors and branches before use.\n// Do not automate approval, release, rejection, or other write actions.\nconst { chromium } = require('playwright');\n(async()=>{\n const browser=await chromium.launch({headless:false});\n const context=await browser.newContext();\n const page=await context.newPage();\n await page.goto(${JSON.stringify(navigations[0]?.url||'https://replace-with-your-portal-url')});\n // Log in manually if authorized and required.\n\n${lines||'// No recorded actions yet.'}\n\n // Add explicit branches based on observed status text and validate counts.\n // Example: if (await page.getByText('Pending', {exact:false}).count()) { /* read-only extraction */ }\n // await browser.close();\n})();\n`;draft=redact(draft);fs.writeFileSync(path.join(REC,(recordingFileStem||('PR_Workflow_'+fileStamp()))+'_playwright_workflow_draft.js'),draft);fs.writeFileSync(path.join(REC,'playwright_workflow_draft.js'),draft);res.type('text/plain').send(draft)});
app.get('/api/frame', (req,res)=>{const rel=String(req.query.file||'');if(!/^[A-Za-z0-9_-]+_frames\/frame_\d{5}\.jpg$/.test(rel))return res.status(400).send('Invalid frame path.');const full=path.resolve(REC,rel);if(!full.startsWith(path.resolve(REC)+path.sep)||!fs.existsSync(full))return res.status(404).send('Screen frame not found.');res.setHeader('Cache-Control','no-store');res.sendFile(full)});
app.delete('/api/recordings/:file',(req,res)=>{try{const name=String(req.params.file||'');const m=name.match(/^([A-Za-z0-9_-]+_\d{4}-\d{2}-\d{2}T[0-9-]+Z)_workflow_capture\.json$/);if(!m)return res.status(400).json({error:'Invalid recording name.'});const stem=m[1];if(recording&&stem===recordingFileStem)return res.status(409).json({error:'This recording is active. Stop it before deleting.'});const removed=[];for(const n of [name,stem+'_frames',stem+'_playwright_workflow_draft.js']){const full=path.resolve(REC,n);if(!full.startsWith(path.resolve(REC)+path.sep))continue;if(fs.existsSync(full)){fs.rmSync(full,{recursive:true,force:true});removed.push(n);}}res.json({ok:true,removed})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/download/:file',(req,res)=>{let name=req.params.file;if(!['latest_inspection.json','playwright_workflow_draft.js'].includes(name)&&! /^[A-Za-z0-9_-]+_\d{4}-\d{2}-\d{2}T[0-9-]+Z_(workflow_capture\.json|playwright_workflow_draft\.js)$/.test(name))return res.status(404).end();let f=path.join(name==='latest_inspection.json'?OUT:REC,name);if(!fs.existsSync(f))return res.status(404).send('Run inspection/export first.');res.download(f)});

// ---- PR status lookup (see lookup.js, tracker.js and lookup-config.json) ----
// Results live in the shared folder so they survive new app versions: <shared>\results\PR_Status_Tracker.xlsx
const RESULTS = process.env.PORTABLE_ARIBA_FILES ? path.join(process.env.PORTABLE_ARIBA_FILES, 'results') : path.join(OUT, 'results');
fs.mkdirSync(RESULTS, {recursive:true});
// Reads PR numbers from the first (selected) sheet. Works with or without a header row; uses the first column unless a header names another.
function readPrNumbers(sheetName){
 const meta=excelCurrent();if(!meta)throw new Error('Upload a workbook first.');
 const wb=XLSX.readFile(path.join(INPUT,meta.storedFile),{cellDates:false});
 const name=sheetName||meta.selectedSheet||wb.SheetNames[0];const ws=wb.Sheets[name];if(!ws)throw new Error('Worksheet not found.');
 const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false}).filter(r=>r.some(c=>String(c??'').trim()!==''));
 if(!rows.length)throw new Error('The worksheet is empty.');
 const headerless=/^\d{6,}$/.test(String(rows[0][0]??'').trim());
 let col=0;if(!headerless){const i=rows[0].map(v=>String(v||'')).findIndex(x=>/\b(pr|requisition|rfp|event|number|no|id)\b/i.test(x));col=i>=0?i:0;}
 const seen=new Set(),numbers=[];
 for(const r of headerless?rows:rows.slice(1)){const v=String(r[col]??'').trim();if(v&&!seen.has(v)){seen.add(v);numbers.push(v)}}
 return {numbers,headerless,column:col,sheet:name,fileName:meta.fileName};
}
const lookup=createLookup({getPage:()=>page,isRecording:()=>recording,resultsDir:RESULTS,readRows:null});
app.post('/api/lookup/start',async(req,res)=>{try{const r=readPrNumbers(String(req.body?.sheetName||''));await lookup.start({numbers:r.numbers,sourceName:r.fileName});res.json({ok:true,count:r.numbers.length})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/lookup/stop',(_req,res)=>res.json({ok:true,stopping:lookup.stop()}));
app.get('/api/lookup/status',(_req,res)=>res.json({ok:true,job:lookup.status(),folder:RESULTS,trackerExists:!!lookup.file()}));
app.get('/api/lookup/headers',(req,res)=>{try{const r=readPrNumbers(String(req.query.sheet||''));res.json({ok:true,count:r.numbers.length,preview:r.numbers.slice(0,5),headerless:r.headerless,column:r.column,sheet:r.sheet,folder:RESULTS,version:APP_VERSION})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/lookup/download',(_req,res)=>{const f=lookup.file();if(!f||!fs.existsSync(f))return res.status(404).send('No tracker workbook yet. Run the lookup first.');res.download(f)});
app.listen(PORT,'127.0.0.1',()=>console.log(`PR Portal Inspector running at http://127.0.0.1:${PORT}\nKeep this PowerShell window open. Use only for authorized read-only inspection.`));
