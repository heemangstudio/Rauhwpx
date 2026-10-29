// node output/heemang-editing/slice3/verify-live.mjs [--prepare-only] [--gates-only|--performance-only]
// Owns only slice3. The parent owns the server, WASM refresh, Enter and cross-cell checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import puppeteer from '../../../rhwp/rhwp-studio/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { ensureChromePath } from '../../../rhwp/rhwp-studio/e2e/agent-bench-harness.mjs';
const out=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(out,'../../..');
assert.equal(execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),'feat/heemang-studio');
const sourceRoot='/Users/pyu/projects/hobbies/Rau/heemang-cleanroom/parity/docs';
const engineRoot='/Users/pyu/projects/hobbies/Rau/HeemangEngine';
const required='4627d0a177b001737524bd7c13bbfda7d2d5e29f';
const vendor=path.join(root,'rhwp/rhwp-studio/vendor/hm-wasm');
const url='http://127.0.0.1:7700/?engine=heemang', timeout=120000;
const input='textarea[data-heemang-input]';
const names=['exam_math.hwp','lang_exam.hwp','nikl_plan.hwp','fdi_q1.hwpx'];
const hash=b=>createHash('sha256').update(typeof b==='string'||Buffer.isBuffer(b)?b:JSON.stringify(b)).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
await fs.mkdir(path.join(out,'docs'),{recursive:true});
const sources=[];
for(const name of [...names,'handbook.hwpx']) {
 const source=name==='handbook.hwpx'?path.join(root,'output/heemang-font-flow/docs',name):path.join(sourceRoot,name);
 const bytes=await fs.readFile(source), copy=path.join(out,'docs',name);
 // Reuse an identical immutable copy on reruns.
 const old=await fs.readFile(copy).catch(()=>null);
 if(!old?.equals(bytes)){await fs.rm(copy,{force:true});await fs.writeFile(copy,bytes,{mode:0o444});}
 await fs.chmod(copy,0o444);
 sources.push({name,source,copy,bytes:bytes.length,sha256:hash(bytes),sourceMode:(await fs.stat(source)).mode&0o777});
}
await fs.writeFile(path.join(out,'source-docs.json'),JSON.stringify(sources,null,2));
if(process.argv.includes('--prepare-only')) {console.log('Prepared immutable copies; browser not launched.');process.exit(0);}
async function provenance(){
 const readme=await fs.readFile(path.join(vendor,'README.md'),'utf8');
 const commit=readme.match(/commit\s*\n`([a-f0-9]{40})`/)?.[1];
 const main=execFileSync('git',['rev-parse','main'],{cwd:engineRoot,encoding:'utf8'}).trim();
 let accepted=false;
 if(commit)try{execFileSync('git',['merge-base','--is-ancestor',required,commit],{cwd:engineRoot,stdio:'ignore'});accepted=true;}catch{}
 const wasm=await fs.readFile(path.join(vendor,'hm_wasm_bg.wasm'));
 const expected=readme.match(/SHA-256\s*\n`([a-f0-9]{64})`/)?.[1];
 return {commit,engineMain:main,matchesEngineMain:commit===main,accepted:accepted&&commit===main,wasmBytes:wasm.length,wasmSha256:hash(wasm),readmeSha256:hash(readme),documentedWasmSha256:expected,hashMatches:hash(wasm)===expected};
}
// Gate before launching Chrome. A descendant is accepted only with Git ancestry evidence.
let gate;const deadline=Date.now()+20*60*1000;let printed=0;
while(Date.now()<deadline){
 gate=await provenance();let server=false;
 try{server=(await fetch(url,{signal:AbortSignal.timeout(2000)})).ok;}catch{}
 if(gate.accepted&&gate.hashMatches&&server)break;
 if(Date.now()-printed>30000){console.log(`Waiting: vendor=${gate.commit}, accepted=${gate.accepted}, hashMatches=${gate.hashMatches}, server=${server}`);printed=Date.now();}
 await delay(3000);
}
assert.ok(gate.accepted&&gate.hashMatches,'Timed out waiting for refreshed vendor provenance');
assert.ok((await fetch(url,{signal:AbortSignal.timeout(3000)})).ok,'Server unavailable');
const run=path.join(out,new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(run,{recursive:true});
const results={url,run,startedAt:new Date().toISOString(),status:'running',gate,sources,documents:[],performance:null,limitations:[
 'Production source and engine remain read-only. All editing uses Chrome mouse/keyboard and production menus. File-system picker/writable handles are intercepted and write only inside this run.',
 'Geometry compares every native line on every page exactly in HWP units. No rounding/tolerance. Paint comparison normalizes runtime face/glyph IDs and excludes glyph binary payloads and runtime epochs; raw packets are preserved. It does not prove glyph-outline identity.',
 'Enter and cross-cell checks are owned by the parent. Native read-only sampling is used to choose clickable text and inspect results.',
 'First paint follows the prior event-to-first synchronous Canvas2D paint definition, which may precede image decode. Typing uses trusted Chrome keys rather than the prior synthetic input sequence; this delivery difference limits direct comparison.',
 'Local dev build, headless Chrome, one machine; no CPU throttling. Measurements are observations, not release-build benchmarks.'
]};
const logs=[];let browser;
const persist=async()=>{await fs.writeFile(path.join(run,'results.json'),JSON.stringify(results,null,2));await fs.writeFile(path.join(out,'latest-results.json'),JSON.stringify(results,null,2));await fs.writeFile(path.join(run,'browser.log'),logs.join('\n'));};
const settle=p=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function pictures(p){await p.waitForFunction(()=>{const v=window.__wasm.viewer;return [...v.pictures.entries.values()].every(e=>e.bitmap||e.failed)&&!v.pictureFrame;},{timeout:30000});await settle(p);}
async function shortcut(p,key){await p.keyboard.down('Meta');try{await p.keyboard.press(key);}finally{await p.keyboard.up('Meta');}}
async function menu(p,group,cmd){await p.click(`[data-menu="${group}"] > .menu-title`);const s=`[data-menu="${group}"] .md-item[data-cmd="${cmd}"]`;await p.waitForSelector(s,{visible:true,timeout:5000});await p.click(s);await settle(p);}
async function field(p,label,value){
 const item=await p.evaluate(label=>{const l=[...document.querySelectorAll('[role="dialog"] label')].find(e=>e.textContent===label);if(!l)throw Error(`Missing ${label}`);const e=document.getElementById(l.htmlFor);return{id:e.id,tag:e.tagName};},label);
 if(item.tag==='SELECT')await p.select(`#${item.id}`,String(value));else {await p.click(`#${item.id}`);await shortcut(p,'a');await p.keyboard.type(String(value));}
}
async function button(p,text){for(const b of await p.$$('[role="dialog"] button'))if(await b.isVisible()&&(await b.evaluate(e=>e.textContent))===text){await b.click();return;}throw Error(`Missing button ${text}`);}
async function upload(p,file){
 const old=await p.evaluate(()=>window.__wasm.documentInstance);
 await (await p.$('#file-input')).uploadFile(file);
 await p.waitForFunction(old=>window.__wasm.documentInstance!==old&&window.__wasm.hasLoadedDocument()&&document.querySelector('canvas[data-heemang-page="0"]')?.width>0,{timeout},old);
 await pictures(p);
}
async function clickText(p,cell){
 const t=await p.evaluate(cell=>{
  const v=window.__wasm.viewer;
  for(let page=0;page<v.pageCount;page++)for(const l of v.page(page).lines){
   if(Boolean(l.list.steps.length)!==cell||l.stops.length<4)continue;
   const a=v.paragraphs(l.list.section,l.list.steps,l.para,1)[0];
   if(!a||a.controls.length||a.caret[0]!==0||a.text.length<6||/[\t\r\n\u00a0\u2007]/.test(a.text)||a.length!==a.text.length+1)continue;
   if(cell){const parents=[];let table=false;for(const step of l.list.steps){const parent=v.paragraphs(l.list.section,parents,step.para,1)[0];if(parent?.controls.some(c=>c.index===step.control&&/table/i.test(c.kind)))table=true;parents.push(step);}if(!table)continue;}
   for(const [offset,x] of l.stops){
    if(offset<=0||offset>=a.text.length-3||/\s/.test(a.text.slice(offset,offset+3)))continue;
    const hit=v.locate({kind:'point',page,x,y:Math.round(l.y+l.height/2)});
    if(!hit||hit.object||hit.position.section!==l.list.section||hit.position.para!==l.para||hit.position.offset!==offset||JSON.stringify(hit.position.steps??[])!==JSON.stringify(l.list.steps))continue;
    return {page,list:l.list,at:hit.position,x,y:l.y+l.height/2,original:a.text};
   }
  }
  throw Error(`No safe ${cell?'table cell':'body'} line`);
 },cell);
 await p.evaluate(t=>{document.getElementById('scroll-container').scrollTop=window.__canvasView.getVirtualScroll().getPageOffset(t.page);},t);
 await p.waitForFunction(i=>document.querySelector(`canvas[data-heemang-page="${i}"]`)?.width>0,{timeout},t.page);
 const point=await p.evaluate(t=>{
  const c=document.querySelector(`canvas[data-heemang-page="${t.page}"]`),r=c.getBoundingClientRect(),packet=window.__wasm.viewer.page(t.page),sc=document.getElementById('scroll-container'),b=sc.getBoundingClientRect();
  const y=r.top+t.y/packet.height*r.height;sc.scrollTop+=y<b.top+30?y-b.top-80:y>b.bottom-30?y-b.bottom+80:0;
  const fresh=c.getBoundingClientRect();return{x:fresh.left+t.x/packet.width*fresh.width,y:fresh.top+t.y/packet.height*fresh.height};
 },t);
 await p.mouse.click(point.x,point.y);await p.waitForFunction(s=>document.activeElement?.matches(s),{timeout:5000},input);return t;
}
async function select(p,cell){const t=await clickText(p,cell);await p.keyboard.down('Shift');try{for(let i=0;i<3;i++)await p.keyboard.press('ArrowRight');}finally{await p.keyboard.up('Shift');}return {...t,range:{from:t.at,to:{...t.at,offset:t.at.offset+3}}};}
async function rawSnapshot(p,dir,label){
 await pictures(p);
 const raw=await p.evaluate(()=>{
  const v=window.__wasm.viewer,pages=[],lists=new Map();
  for(let i=0;i<v.pageCount;i++){const p=v.page(i);pages.push({...p,glyphs:Array.from(p.glyphs)});for(const l of p.lines)lists.set(JSON.stringify(l.list),l.list);}
  for(let i=0;i<v.getSectionCount();i++)lists.set(JSON.stringify({section:i,steps:[]}),{section:i,steps:[]});
  const paragraphs=[...lists.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))).map(list=>{const paragraphs=[];for(let n=0;;n+=1024){const batch=v.paragraphs(list.section,list.steps,n,1024);paragraphs.push(...batch);if(batch.length<1024)break;}return{list,paragraphs};});
  return {state:v.state(),shellRevision:window.__documentState.captureRevision(),shellDirty:window.__documentState.isDirty(),pages,paragraphs,fontRequests:JSON.parse(v.document().fontRequests()),fontBytes:v.engine.fontBytes,fontGeneration:v.engine.fontGeneration};
 });
 await fs.writeFile(path.join(dir,`${label}.json.gz`),gzipSync(JSON.stringify(raw)));
 return raw;
}
function canonical(raw){
 const pages=structuredClone(raw.pages),faces=new Map(),glyphs=new Map();
 for(const p of pages){for(const k of ['contentEpoch','layoutEpoch','fontGeneration','glyphs'])delete p[k];for(const op of p.ops){if(op.face===undefined)continue;const face=op.face;if(!faces.has(face))faces.set(face,faces.size);op.face=faces.get(face);if(!glyphs.has(face))glyphs.set(face,new Map());const ids=glyphs.get(face);for(const g of op.glyphs){if(!ids.has(g[0]))ids.set(g[0],ids.size);g[0]=ids.get(g[0]);}}}
 return pages;
}
function compare(before,after){
 const flatten=s=>s.pages.flatMap(p=>p.lines.map((line,ordinal)=>({page:p.page,ordinal,...line})));
 const a=flatten(before),b=flatten(after),key=l=>JSON.stringify([l.list,l.para,l.line]);
 const indexed=lines=>{const counts=new Map();return new Map(lines.map(l=>{const k=key(l),n=counts.get(k)||0;counts.set(k,n+1);return[`${k}#${n}`,l];}));};
 const am=indexed(a),bm=indexed(b),firstDifferences=[],maxDeltas={y:0,height:0,baseline:0,stopX:0,page:0,stopOffset:0};let changed=0,exact=0,added=0,removed=0,stopCountChanges=0;
 const record=x=>{if(firstDifferences.length<12)firstDifferences.push(x);};
 for(const [k,l] of am){const r=bm.get(k);if(!r){removed++;record({kind:'removed-line',before:l});continue;}
  const deltas={};for(const f of ['y','height','baseline','page']){const d=r[f]-l[f];maxDeltas[f]=Math.max(maxDeltas[f],Math.abs(d));if(d)deltas[f]=d;}
  if(l.stops.length!==r.stops.length)stopCountChanges++;
  for(let i=0;i<Math.min(l.stops.length,r.stops.length);i++){maxDeltas.stopOffset=Math.max(maxDeltas.stopOffset,Math.abs(l.stops[i][0]-r.stops[i][0]));maxDeltas.stopX=Math.max(maxDeltas.stopX,Math.abs(l.stops[i][1]-r.stops[i][1]));}
  const {ordinal:lo,...ll}=l,{ordinal:ro,...rr}=r;
  if(JSON.stringify(ll)===JSON.stringify(rr))exact++;else{changed++;record({kind:'changed-line',key:k,deltas,before:l,after:r});}
 }
 for(const [k,l] of bm)if(!am.has(k)){added++;record({kind:'added-line',after:l});}
 return {pagesBefore:before.pages.length,pagesAfter:after.pages.length,pageCountChange:after.pages.length-before.pages.length,linesBefore:a.length,linesAfter:b.length,lineCountChange:b.length-a.length,matchedLines:exact+changed,exactLines:exact,changedLines:changed,addedLines:added,removedLines:removed,stopCountChanges,maxDeltasHu:maxDeltas,maxGeometryDeltaPt:Math.max(maxDeltas.y,maxDeltas.height,maxDeltas.baseline,maxDeltas.stopX)/100,allLineGeometryExact:!changed&&!added&&!removed,paragraphsExact:hash(before.paragraphs)===hash(after.paragraphs),normalizedPaintExact:hash(canonical(before))===hash(canonical(after)),firstDifferences};
}
async function saveIdle(p){await p.evaluate(async()=>{const m=await import('/src/command/commands/file.ts');await m.whenSavesIdle();});await settle(p);}
async function state(p){return p.evaluate(()=>({native:window.__wasm.viewer.state(),shellRevision:window.__documentState.captureRevision(),dirty:window.__documentState.isDirty(),savedEvents:window.__slice3SaveEvents.length,writes:window.__slice3Saved.length}));}
async function newPage(doc,viewport={width:1440,height:1200,deviceScaleFactor:1}){
 assert.ok(!results.hmrAbort,'INSTRUMENTATION: production HMR interrupted verification');
 const p=await browser.newPage();await p.setViewport(viewport);
 const hmr=await p.createCDPSession();await hmr.send('Network.enable');hmr.on('Network.webSocketFrameReceived',e=>{let message;try{message=JSON.parse(e.response.payloadData);}catch{return;}if(['update','full-reload'].includes(message.type)){results.hmrAbort={at:new Date().toISOString(),message};logs.push(`ABORT: Vite ${message.type}`);void p.close().catch(()=>{});}});p.__wasmResponses=[];p.__wasmPending=[];p.on('response',response=>{if(!response.url().includes('hm_wasm_bg.wasm'))return;const pending=response.buffer().then(bytes=>p.__wasmResponses.push({url:response.url(),status:response.status(),bytes:bytes.length,sha256:hash(bytes)})).catch(e=>p.__wasmResponses.push({url:response.url(),error:e.message}));p.__wasmPending.push(pending);});
 p.on('pageerror',e=>{doc.errors.push(e.stack);logs.push(`${doc.name} pageerror ${e.stack}`);});p.on('console',m=>{if(['error','warn'].includes(m.type()))logs.push(`${doc.name} ${m.type()} ${m.text()}`);});
 p.on('dialog',d=>{logs.push(`${doc.name} dialog ${d.message()}`);void d.dismiss();});
 await p.exposeFunction('__slice3Write',async(base64,name)=>{const file=path.join(doc.dir,`saved-${path.basename(name)}`),bytes=Buffer.from(base64,'base64');await fs.writeFile(file,bytes);return{path:file,bytes:bytes.length,sha256:hash(bytes)};});
 await p.evaluateOnNewDocument(()=>{
  window.__slice3SaveMode='success';window.__slice3Saved=[];window.__slice3SaveIO=[];window.__slice3SaveEvents=[];
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async options=>{
   const record={mode:window.__slice3SaveMode,options,stages:['picker']};window.__slice3SaveIO.push(record);
   if(record.mode==='cancel'){record.stages.push('cancel');throw new DOMException('Slice3 picker cancel','AbortError');}
   const name=options.suggestedName;let blob;
   return{kind:'file',name,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',getFile:async()=>new File([blob||''],name),createWritable:async()=>{
    record.stages.push('createWritable');return{write:async data=>{record.stages.push('write');if(window.__slice3SaveMode==='failure')throw Error('SLICE3_INJECTED_WRITE_FAILURE');blob=data instanceof Blob?data:new Blob([data]);},close:async()=>{record.stages.push('close');const a=new Uint8Array(await blob.arrayBuffer());let b='';for(let i=0;i<a.length;i+=32768)b+=String.fromCharCode(...a.subarray(i,i+32768));window.__slice3Saved.push(await window.__slice3Write(btoa(b),name));},abort:async()=>{record.stages.push('abort');}};
   }};
  }});
 });
 await p.goto(url,{waitUntil:'networkidle0',timeout});await p.waitForFunction(()=>window.__canvasView&&window.__eventBus&&window.__wasm?.viewer,{timeout});

 await p.evaluate(()=>{window.__eventBus.on('document-saved',e=>window.__slice3SaveEvents.push(e));});return p;
}
async function servedWasm(p,doc){
 await Promise.all(p.__wasmPending);doc.servedWasm=p.__wasmResponses.at(-1);
 if(!doc.servedWasm)throw Error('INSTRUMENTATION: No hm-wasm response captured');
 assert.equal(doc.servedWasm.sha256,gate.wasmSha256,'INSTRUMENTATION: served WASM differs from gate');
}
async function format(p,doc,cell){
 const target=await select(p,cell),before=await state(p);
 await menu(p,'format','format:char-shape');await p.waitForSelector('[role="dialog"][aria-label="글자 모양"]',{visible:true});
 for(const [label,value]of [['진하게','false'],['기울임','true'],['밑줄','true'],['크기 (pt)','13.25'],['글자 색','#b12345']])await field(p,label,value);
 await button(p,'적용');await p.waitForSelector('.modal-overlay',{hidden:true});await settle(p);
 let copied=await p.evaluate(r=>window.__wasm.viewer.copyText(r),target.range);
 assert.match(copied.html,/13.25pt/);assert.match(copied.html,/#b12345/i);assert.match(copied.html,/italic/);assert.match(copied.html,/underline/);
 await select(p,cell);await menu(p,'format','format:para-shape');await p.waitForSelector('[role="dialog"][aria-label="문단 모양"]',{visible:true});
 for(const [label,value]of [['정렬','center'],['들여쓰기 (pt)','3'],['왼쪽 여백 (pt)','4'],['문단 위 (pt)','2'],['문단 아래 (pt)','5'],['줄 간격 (%)','175']])await field(p,label,value);
 await button(p,'적용');await p.waitForSelector('.modal-overlay',{hidden:true});await pictures(p);
 const after=await state(p);assert.equal(after.native.undo,before.native.undo+2);assert.ok(after.native.contentEpoch>before.native.contentEpoch);assert.ok(after.dirty);
 doc.formatting.push({context:cell?'table cell':'body',target,before,after,html:copied.html});
}
async function gateDocument(name){
 const doc={name,dir:path.join(run,path.parse(name).name),status:'running',errors:[],formatting:[]};results.documents.push(doc);await fs.mkdir(doc.dir,{recursive:true});const p=await newPage(doc);
 try{
  await upload(p,path.join(out,'docs',name));await servedWasm(p,doc);await clickText(p,false);await p.screenshot({path:path.join(doc.dir,'source.png')});
  const source=await rawSnapshot(p,doc.dir,'source');
  await format(p,doc,false);await format(p,doc,true);
  await clickText(p,false);await p.screenshot({path:path.join(doc.dir,'before-save.png')});
  const before=await rawSnapshot(p,doc.dir,'before-save');
  doc.editGeometry=compare(source,before);assert.equal(doc.editGeometry.paragraphsExact,true,'Formatting changed text/paragraph structure');assert.notEqual(hash(canonical(source)),hash(canonical(before)),'Formatting did not change native paint/geometry');
  doc.stylesBefore=await Promise.all(doc.formatting.map(x=>p.evaluate(r=>window.__wasm.viewer.copyText(r),x.target.range)));
  doc.failurePaths=[];
  for(const mode of ['cancel','failure']){
   const a=await state(p);await p.evaluate(mode=>window.__slice3SaveMode=mode,mode);await menu(p,'file','file:save');await saveIdle(p);const b=await state(p);
   const io=await p.evaluate(()=>window.__slice3SaveIO.at(-1));const unchanged=JSON.stringify(a)===JSON.stringify(b);const snapshot=await rawSnapshot(p,doc.dir,`save-${mode}`);const comparison=compare(before,snapshot);
   doc.failurePaths.push({mode,before:a,after:b,unchanged,io,geometryExact:comparison.allLineGeometryExact,paintExact:comparison.normalizedPaintExact});
   assert.ok(unchanged,`${mode} changed dirty/history/revision or acknowledged save`);assert.ok(comparison.allLineGeometryExact&&comparison.normalizedPaintExact,`${mode} changed document`);
   if(mode==='failure')assert.ok(io.stages.includes('abort')&&!io.stages.includes('close'),'Failed writable must abort without close');
  }
  await p.evaluate(()=>window.__slice3SaveMode='success');doc.saveBefore=await state(p);await menu(p,'file','file:save');await saveIdle(p);
  await p.waitForFunction(()=>window.__slice3Saved.length===1&&!window.__wasm.viewer.state().dirty&&!window.__documentState.isDirty(),{timeout});
  doc.saveAfter=await state(p);doc.saved=await p.evaluate(()=>window.__slice3Saved.at(-1));doc.saveIO=await p.evaluate(()=>window.__slice3SaveIO);
  for(const f of ['contentEpoch','undo','redo'])assert.equal(doc.saveAfter.native[f],doc.saveBefore.native[f],`Save altered ${f}`);assert.equal(doc.saveAfter.shellRevision,doc.saveBefore.shellRevision);
  const afterSave=await rawSnapshot(p,doc.dir,'after-save');doc.saveComparison=compare(before,afterSave);
  const bytes=await fs.readFile(doc.saved.path),original=await fs.readFile(path.join(out,'docs',name));assert.ok(bytes.subarray(0,8).equals(original.subarray(0,8)),'Same-format container signature changed');assert.equal(path.extname(doc.saved.path),path.extname(name));
  await upload(p,doc.saved.path);await clickText(p,false);await p.screenshot({path:path.join(doc.dir,'reopened.png')});
  const reopened=await rawSnapshot(p,doc.dir,'reopened');doc.reopenComparison=compare(before,reopened);
  doc.stylesAfter=await Promise.all(doc.formatting.map(x=>p.evaluate(r=>window.__wasm.viewer.copyText(r),x.target.range)));
  doc.stylesExact=JSON.stringify(doc.stylesBefore)===JSON.stringify(doc.stylesAfter);
  doc.reopenedNativeBytesSha256=await p.evaluate(()=>{const a=window.__wasm.viewer.serialize(false);return crypto.subtle.digest('SHA-256',a).then(b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''));});
  await clickText(p,true);await p.screenshot({path:path.join(doc.dir,'reopened-cell.png')});
  doc.status=doc.reopenComparison.allLineGeometryExact&&doc.reopenComparison.normalizedPaintExact&&doc.reopenComparison.paragraphsExact&&doc.stylesExact&&doc.reopenedNativeBytesSha256===doc.saved.sha256&&!doc.errors.length?'passed':'failed';
 }catch(e){doc.status=e.message.includes('INSTRUMENTATION:')?'instrumentation-failed':'failed';doc.failure=e.stack;await p.screenshot({path:path.join(doc.dir,'failure.png')}).catch(()=>{});}
 finally{await p.close();await persist();console.log(`${name}: ${doc.status}; geometry ${JSON.stringify(doc.reopenComparison||{})}`);}
}
function percentile(samples,field,p){const a=samples.map(s=>s[field]).sort((a,b)=>a-b);assert.ok(a.every(Number.isFinite));return a[Math.ceil(a.length*p)-1];}
async function typing(p){
 const target=await clickText(p,false),before=await state(p);
 await p.evaluate(()=>{
  const v=window.__wasm.viewer,original=v.renderPageToCanvas;let rendered=-1,pending=null;
  const samples=[],events=[];window.__slice3Typing={samples,events};
  v.renderPageToCanvas=function(...args){const r=original.apply(this,args);rendered=v.state().contentEpoch;return r;};
  const keydown=e=>{
   if(e.target!==document.querySelector('textarea[data-heemang-input]')||e.key.length!==1)return;
   const epoch=v.state().contentEpoch;pending={key:e.key,keydownTrusted:e.isTrusted,epoch,started:performance.now()};
   const sample=pending;
   const frame=()=>requestAnimationFrame(()=>setTimeout(()=>{
    if(rendered<epoch+1){frame();return;}
    sample.keyToPaintMs=performance.now()-sample.started;sample.newEpoch=v.state().contentEpoch;sample.renderedEpoch=rendered;samples.push(sample);
   },0));frame();
  };
  const beforeinput=e=>{
   if(!pending||e.inputType!=='insertText')return;
   pending.beforeinputTrusted=e.isTrusted;pending.inputData=e.data;
  };
  window.addEventListener('keydown',keydown,true);window.addEventListener('beforeinput',beforeinput,true);
  window.__slice3RestoreTyping=()=>{v.renderPageToCanvas=original;window.removeEventListener('keydown',keydown,true);window.removeEventListener('beforeinput',beforeinput,true);};
 });
 const keys='abcdefghijklmnopqrstuvwxyzabcdefghij';
 try{for(const [i,key]of [...keys].entries()){await p.keyboard.press(key);await p.waitForFunction(n=>window.__slice3Typing.samples.length===n,{timeout:15000},i+1);}}
 finally{await p.evaluate(()=>window.__slice3RestoreTyping());}
 const samples=await p.evaluate(()=>window.__slice3Typing.samples),after=await state(p);
 assert.equal(after.native.contentEpoch,before.native.contentEpoch+keys.length);assert.equal(after.native.undo,before.native.undo+keys.length);
 assert.ok(samples.every(s=>s.keydownTrusted&&s.beforeinputTrusted&&s.newEpoch===s.epoch+1),'Every sample must be trusted and mutate once');
 const actual=await p.evaluate(t=>window.__wasm.viewer.getParagraphText(t.at.section,t.at.para,t.at.steps),target);
 assert.equal(actual,target.original.slice(0,target.at.offset)+keys+target.original.slice(target.at.offset));
 return {count:samples.length,units:'milliseconds',keyToPaint:{p50:percentile(samples,'keyToPaintMs',.5),p95:percentile(samples,'keyToPaintMs',.95)},definition:'36 trusted Chrome keyboard.press characters at native-hit-tested body text. keyToPaint starts in capture-phase trusted keydown and finishes after rAF + macrotask with rendered contentEpoch >= key epoch+1. Handler latency is not measured: capture-phase microtask timing does not bracket the production mutation handlers. No synthetic input or direct document mutation.',target,before,after,samples};
}
async function performanceRun(){
 const doc={name:'handbook.hwpx',dir:path.join(run,'handbook'),status:'running',errors:[]};results.performance=doc;await fs.mkdir(doc.dir,{recursive:true});
 const p=await newPage(doc,{width:1440,height:2000,deviceScaleFactor:1});
 try{
  const bytes=await fs.readFile(path.join(out,'docs',doc.name));
  // Keep the older first-paint timer's exact boundary and public open route.
  doc.open=await p.evaluate(async({base64,name})=>{
   const wasm=window.__wasm,v=wasm.viewer,original=v.renderPageToCanvas;
   let firstPaintMs=null,firstVisiblePicturesPaintedMs=null;const started=performance.now();
   v.renderPageToCanvas=function(...args){const r=original.apply(this,args);firstPaintMs??=performance.now()-started;const es=v.pictures.entries;if(es.size&&[...es.values()].every(e=>e.bitmap||e.failed))firstVisiblePicturesPaintedMs??=performance.now()-started;return r;};
   window.__slice3RestoreOpen=()=>{v.renderPageToCanvas=original;return{firstVisiblePicturesPaintedMs};};
   const requestId=`slice3-${crypto.randomUUID()}`;
   const result=await new Promise(resolve=>{
    const timer=setTimeout(()=>{off();resolve({ok:false,error:'Open timeout'});},120000);
    const off=window.__eventBus.on('open-document-bytes:done',e=>{if(e.requestId!==requestId)return;clearTimeout(timer);off();resolve(e);});
    window.__eventBus.emit('open-document-bytes',{bytes:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),fileName:name,requestId,suppressDialogs:true,skipUnsavedGuard:true});
   });
   return{result,firstPaintMs,openCompleteMs:performance.now()-started,pages:wasm.pageCount,memory:wasm.wasmMemoryBytes,wasmMiB:wasm.wasmMemoryBytes/1048576,zoom:window.__canvasView.getViewportManager().getZoom()};
  },{base64:bytes.toString('base64'),name:doc.name});
  assert.equal(doc.open.result.ok,true);assert.ok(doc.open.firstPaintMs>0);await servedWasm(p,doc);
  await p.waitForFunction(()=>document.querySelector('canvas[data-heemang-page="0"]')?.width>0,{timeout});await pictures(p);
  Object.assign(doc.open,await p.evaluate(()=>window.__slice3RestoreOpen()));
  await p.screenshot({path:path.join(doc.dir,'studio.png')});
  await p.evaluate(()=>window.__canvasView.getViewportManager().setZoom(0.8));await settle(p);
  for(const index of [...new Set([0,Math.min(1,doc.open.pages-1),doc.open.pages-1])]){
   await p.evaluate(i=>document.getElementById('scroll-container').scrollTop=window.__canvasView.getVirtualScroll().getPageOffset(i),index);
   await p.waitForFunction(i=>document.querySelector(`canvas[data-heemang-page="${i}"]`)?.width>0,{timeout},index);await pictures(p);
   const bounds=await p.$eval(`canvas[data-heemang-page="${index}"]`,c=>{const r=c.getBoundingClientRect();return{x:Math.max(0,r.x),y:Math.max(0,r.y),width:r.width,height:r.height};});
   await p.screenshot({path:path.join(doc.dir,`page-${String(index+1).padStart(3,'0')}.png`),clip:bounds,captureBeyondViewport:true});
  }
  doc.fontAudit=await p.evaluate(()=>{const v=window.__wasm.viewer;return{fontBytes:v.engine.fontBytes,fontGeneration:v.engine.fontGeneration,fontRequests:JSON.parse(v.document().fontRequests()),outlineRequests:JSON.parse(v.engine.outlineRequests())};});
  doc.settledWasmBytes=await p.evaluate(()=>window.__wasm.viewer.wasmMemoryBytes);
  await p.evaluate(()=>globalThis.gc?.());const cdp=await p.createCDPSession();doc.heap=await cdp.send('Runtime.getHeapUsage');await cdp.detach();doc.jsHeapMiB=doc.heap.usedSize/1048576;
  await p.setViewport({width:1440,height:1200,deviceScaleFactor:1});await settle(p);doc.typing=await typing(p);doc.afterTypingWasmBytes=await p.evaluate(()=>window.__wasm.viewer.wasmMemoryBytes);await p.screenshot({path:path.join(doc.dir,'after-typing.png')});doc.status=doc.errors.length?'failed':'passed';
 }catch(e){doc.status=e.message.includes('INSTRUMENTATION:')?'instrumentation-failed':'failed';doc.failure=e.stack;await p.screenshot({path:path.join(doc.dir,'failure.png')}).catch(()=>{});}
 finally{await p.close();await persist();console.log(`handbook: ${doc.status}, ${JSON.stringify(doc.open)}, typing ${JSON.stringify(doc.typing&&{paint:doc.typing.keyToPaint})}`);}
}
function report(){
 const lines=[`# Slice 3 live verification`, '',`Runtime: ${url}`,`Engine: ${gate.commit}. WASM SHA-256: ${gate.wasmSha256}.`,`Status: ${results.status}. Chrome: ${results.chromeVersion||'not launched'}.`, '', '| Document | Pages before/reopen | Lines before/reopen | Changed/added/removed lines | Max geometry delta, HU | Text / paint / style exact |', '| --- | --- | --- | --- | --- | --- |'];
 for(const d of results.documents){const c=d.reopenComparison;lines.push(c?`| ${d.name} | ${c.pagesBefore}/${c.pagesAfter} | ${c.linesBefore}/${c.linesAfter} | ${c.changedLines}/${c.addedLines}/${c.removedLines} | ${Math.max(c.maxDeltasHu.y,c.maxDeltasHu.height,c.maxDeltasHu.baseline,c.maxDeltasHu.stopX)} | ${c.paragraphsExact}/${c.normalizedPaintExact}/${d.stylesExact} |`:`| ${d.name} | Failed before comparison | | | | ${d.failure?.split('\n')[0]} |`);}
 lines.push('', 'Formatting used the real character and paragraph dialogs in body text and a table cell. Save used File > Save, production serialization and a writable handle that wrote into this run. Reopen used the actual file input and exact intercepted saved bytes. Before-save/reopened screenshots and full native packets are in each document folder. Every native line and stop was compared with zero tolerance. First differences and maximum field deltas are in results.json. 100 HU = 1 pt.', '');
 for(const d of results.documents)lines.push(`${d.name}: ${d.status}. Save cancellation/write-failure checks: ${d.failurePaths?.map(x=>`${x.mode} ${x.unchanged&&x.geometryExact&&x.paintExact?'preserved document and unsaved state':'FAILED'}`).join('; ')||'not reached'}. Saved bytes: ${d.saved?.bytes??'not reached'}.`);
 const p=results.performance;
 if(p){lines.push('',`Handbook: ${p.status}. First paint ${p.open?.firstPaintMs} ms; open complete ${p.open?.openCompleteMs} ms; pages ${p.open?.pages}; WASM ${p.open?.memory} bytes / ${p.open?.wasmMiB} MiB; JS heap ${p.heap?.usedSize} bytes / ${p.jsHeapMiB} MiB.`);if(p.typing)lines.push(`36 trusted keys: key-to-paint p50 ${p.typing.keyToPaint.p50} ms / p95 ${p.typing.keyToPaint.p95} ms.`,p.typing.definition);if(p.failure)lines.push(p.failure.split('\n')[0]);}
 lines.push('', 'Prior evidence: heemang-first-paint/verification.json reports handbook 1148.800000011921 ms first paint, 1603.699999988079 ms open complete, 102.6875 MiB WASM, 52.40935516357422 MiB JS, 385 pages. heemang-editing/live/results.json reports 36 synthetic keys, paint p50 14.400000035762787 ms and p95 23.600000023841858 ms, handler p50 9.099999964237213 ms and p95 10.099999964237213 ms.', '', 'First-paint timer/viewport, WASM-at-open memory sampling, screenshot page visits and explicit GC before Runtime.getHeapUsage follow prior definitions. Typing uses the same rAF + macrotask / rendered epoch boundary and character sequence. Trusted key delivery differs from the old synthetic all-events task. Typing uses the prior typing viewport of 1440x1200 at DPR 1; the first-paint/memory phase uses 1440x2000 at DPR 1.', '',...results.limitations.map(x=>`- ${x}`),'',`Evidence: ${run}`,`Sources unchanged: ${results.sourcesUnchanged??'not checked'}. Vendor unchanged during run: ${results.vendorUnchanged??'not checked'}.`);
 return lines.join('\n')+'\n';
}
try{
 ensureChromePath();browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,protocolTimeout:300000,args:['--disable-dev-shm-usage','--js-flags=--expose-gc']});results.chromeVersion=await browser.version();results.chromePath=process.env.CHROME_PATH;
 if(!process.argv.includes('--performance-only'))for(const name of names){assert.equal((await provenance()).wasmSha256,gate.wasmSha256,'Vendor changed during checks');await gateDocument(name);}
 if(!process.argv.includes('--gates-only'))await performanceRun();
 results.status=results.documents.every(d=>d.status==='passed')&&(!results.performance||results.performance.status==='passed')?'passed':'failed';
}catch(e){results.status='failed';results.failure=e.stack;}
finally{
 if(browser)await browser.close();results.finishedAt=new Date().toISOString();results.vendorEnd=await provenance();results.vendorUnchanged=results.vendorEnd.wasmSha256===gate.wasmSha256&&results.vendorEnd.readmeSha256===gate.readmeSha256;
 results.sourcesUnchanged=true;for(const s of sources)if(hash(await fs.readFile(s.source))!==s.sha256)results.sourcesUnchanged=false;
 if(!results.sourcesUnchanged||!results.vendorUnchanged||results.hmrAbort)results.status='failed';await persist();await fs.writeFile(path.join(run,'report.md'),report());await fs.writeFile(path.join(out,'report.md'),report());console.log(`Evidence: ${run}`);if(results.status!=='passed')process.exitCode=1;
}
