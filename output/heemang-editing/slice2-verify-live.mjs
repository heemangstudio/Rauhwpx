// Standalone: node output/heemang-editing/slice2-verify-live.mjs [exam_math.hwp ...]
// Reuses the existing server. All document mutations use production UI events.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import puppeteer from '../../rhwp/rhwp-studio/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { ensureChromePath } from '../../rhwp/rhwp-studio/e2e/agent-bench-harness.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'output/heemang-editing/slice2');
const run = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
const menuOnly=process.argv.includes('--clipboard-menu');
const fontDiagnostic=process.argv.includes('--font-diagnostic');
const targetedFinal=process.argv.includes('--targeted-final');
const searchTrace=process.argv.includes('--search-trace');
const stubsOnly=process.argv.includes('--stubs-only');
const docArgs=process.argv.slice(2).filter(arg=>!arg.startsWith('--'));
const names = docArgs.length ? docArgs : ['exam_math.hwp','lang_exam.hwp','nikl_plan.hwp','fdi_q1.hwpx'];
const url = 'http://127.0.0.1:7700/?engine=heemang';
const timeout = 60000, inputSelector = 'textarea[data-heemang-input]';
const results = { url, run, mode:stubsOnly?'additional-real-ui-stubs':searchTrace?'native-search-read-only-trace':targetedFinal?'final-adjacent-find-and-menu-clipboard':fontDiagnostic?'post-edit-font-diagnostic':menuOnly?'real-edit-menu-clipboard':'full-ui', startedAt: new Date().toISOString(), status:'running', documents:[], logs:[], boundaries:{save:'Real File menu and production serialization; file picker intercepted to writable output copies',clipboard:'Real Chrome Meta+C/X/V first; any event fallback explicitly recorded',open:'Production open-document-bytes event with copied fixtures',native:'Read-only snapshots; no adapter mutations'} };
const hash = data => createHash('sha256').update(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)).digest('hex');
const log = (kind,message) => { results.logs.push({ time:new Date().toISOString(),kind,message }); };
const persist = async () => { await fs.writeFile(path.join(run,'results.json'),JSON.stringify(results,null,2)); await fs.writeFile(path.join(out,'latest-results.json'),JSON.stringify(results,null,2)); await fs.writeFile(path.join(run,'matrix.json'),JSON.stringify({status:results.status,documents:results.documents.map(d=>({name:d.name,status:d.status,checks:d.checks.map(c=>({name:c.name,status:c.status,error:c.error?.split('\n')[0]})),failure:d.failure?.split('\n')[0]}))},null,2)); await fs.writeFile(path.join(run,'browser.log'),results.logs.map(x=>`${x.time} ${x.kind} ${x.message}`).join('\n')); };
async function shortcut(page, key, shift = false) {
  await page.keyboard.down('Meta');
  try {
    if (shift) await page.keyboard.down('Shift');
    try { await page.keyboard.press(key); }
    finally { if (shift) await page.keyboard.up('Shift'); }
  } finally { await page.keyboard.up('Meta'); }
}
async function snapshot(page, list) {
  return page.evaluate(list => {
    const v = window.__wasm.viewer;
    const paragraphs = [];
    for (let from = 0; ; from += 1024) {
      const batch = v.paragraphs(list.section, list.steps, from, 1024);
      paragraphs.push(...batch);
      if (batch.length < 1024) break;
    }
    return { list, state: v.state(), paragraphs, focused: document.activeElement?.matches('textarea[data-heemang-input]') };
  }, list);
}
const texts = s => s.paragraphs.map(p => p.text);
function unchanged(before, after) {
  assert.deepEqual(texts(after), texts(before));
  for (const field of ['contentEpoch', 'undo', 'redo']) assert.equal(after.state[field], before.state[field], field);
}
function edited(before, after, groups = 1) {
  assert.ok(after.state.contentEpoch > before.state.contentEpoch, 'content epoch did not advance');
  assert.equal(after.state.undo, before.state.undo + groups, 'undo groups');
  assert.equal(after.state.redo, 0, 'redo must clear after a new edit');
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function open(page, bytes, name) {
  const reply = await page.evaluate(async ({ base64, name }) => {
    const requestId = `editing-live-${crypto.randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { off(); resolve({ ok: false, error: 'open-document-bytes timed out' }); }, 120000);
      const off = window.__eventBus.on('open-document-bytes:done', payload => {
        if (payload.requestId !== requestId) return;
        clearTimeout(timer); off(); resolve(payload);
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes: Uint8Array.from(atob(base64), c => c.charCodeAt(0)), fileName: name,
        requestId, suppressDialogs: true, skipUnsavedGuard: true,
      });
    });
  }, { base64: bytes.toString('base64'), name });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  await page.waitForFunction(() => window.__wasm?.viewer?.pageCount > 0 && document.querySelector('canvas[data-heemang-page="0"]')?.width > 0, { timeout });
  await settle(page);
}

// Choose text with no controls and a nonempty interior stop; never guess screen coordinates.
async function clickText(page, cell, exclude, shiftClick=false) {
  const target = await page.evaluate(({cell,exclude,loose}) => {
    const v = window.__wasm.viewer;
    for (let index = 0; index < v.pageCount; index++) {
      const packet = v.page(index);
      for (const line of packet.lines) {
        if (Boolean(line.list.steps.length) !== cell || line.stops.length < (loose?1:4) || (exclude && JSON.stringify(exclude)===JSON.stringify(line.list))) continue;
        const paragraph = v.paragraphs(line.list.section, line.list.steps, line.para, 1)[0];
        if (!paragraph || (!loose && (paragraph.controls.length || paragraph.caret[0] !== 0 || paragraph.text.length < 6 || /[\t\r\n\u00a0\u2007]/.test(paragraph.text)))) continue;
        // Only ordinary text remains: initial wire offsets equal JS UTF-16 indexes.
        if (cell) {
          const parents = [];
          let hasTable = false;
          for (const step of line.list.steps) {
            const parent = v.paragraphs(line.list.section, parents, step.para, 1)[0];
            if (parent?.controls.some(c => c.index === step.control && /table/i.test(c.kind))) hasTable = true;
            parents.push(step);
          }
          if (!hasTable) continue;
        }
        if (!loose && [...paragraph.text].reduce((n,c)=>n+c.length,0)!==paragraph.length-1) continue;
        const stop = line.stops.find(([offset]) => loose?(offset>=paragraph.caret[0]&&offset<=paragraph.caret[1]):(offset > 0 && offset < paragraph.text.length - 3 && !/\s/.test(paragraph.text.slice(offset,offset+3))));
        if (!stop) continue;
        const hit = v.locate({ kind: 'point', page: index, x: stop[1], y: Math.round(line.y + line.height / 2) });
        if (!hit || hit.object || hit.position.section !== line.list.section || hit.position.para !== line.para || hit.position.offset !== stop[0] || JSON.stringify(hit.position.steps ?? []) !== JSON.stringify(line.list.steps)) continue;
        return { page: index, list: line.list, at: hit.position, hu: { x: stop[1], y: line.y + line.height / 2 }, original: paragraph.text };
      }
    }
    throw new Error(`No safe ${cell ? 'cell' : 'body'} text line found`);
  }, {cell,exclude,loose:shiftClick});
  await page.evaluate(index => {
    const scroll = document.getElementById('scroll-container');
    scroll.scrollTop = window.__canvasView.getVirtualScroll().getPageOffset(index);
  }, target.page);
  await page.waitForFunction(index => document.querySelector(`canvas[data-heemang-page="${index}"]`)?.width > 0, { timeout }, target.page);
  const point = await page.evaluate(target => {
    const c = document.querySelector(`canvas[data-heemang-page="${target.page}"]`);
    const rect = c.getBoundingClientRect();
    const packet = window.__wasm.viewer.page(target.page);
    const x = rect.left + target.hu.x / packet.width * rect.width;
    const y = rect.top + target.hu.y / packet.height * rect.height;
    // Scroll tall pages to the line, retaining horizontal centering.
    const scroller = document.getElementById('scroll-container');
    const bounds = scroller.getBoundingClientRect();
    const delta = y < bounds.top + 30 ? y - bounds.top - 80 : y > bounds.bottom - 30 ? y - bounds.bottom + 80 : 0;
    scroller.scrollTop += delta;
    const fresh = c.getBoundingClientRect();
    return { x: fresh.left + target.hu.x / packet.width * fresh.width, y: fresh.top + target.hu.y / packet.height * fresh.height };
  }, target);
  if(shiftClick)await page.keyboard.down('Shift');try{await page.mouse.click(point.x, point.y);}finally{if(shiftClick)await page.keyboard.up('Shift');}
  await page.waitForFunction(selector => document.activeElement?.matches(selector), { timeout: 5000 }, inputSelector);
  return target;
}
async function native(page, doc, label) {
  await settle(page);
  const raw = await page.evaluate(() => {
    const v=window.__wasm.viewer, pages=[], lists=new Map();
    for(let i=0;i<v.pageCount;i++) {
      const p=v.page(i); const {contentEpoch,layoutEpoch,fontGeneration,glyphs,...packet}=p;
      pages.push({...packet,glyphs:Array.from(glyphs)});
      for(const l of p.lines) lists.set(JSON.stringify(l.list),l.list);
    }
    for(let i=0;i<v.getSectionCount();i++) lists.set(JSON.stringify({section:i,steps:[]}),{section:i,steps:[]});
    const paragraphs=[...lists.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))).map(list=>{
      const all=[];for(let from=0;;from+=1024){const ps=v.paragraphs(list.section,list.steps,from,1024);all.push(...ps);if(ps.length<1024)break;}
      return {list,paragraphs:all};
    });
    return {state:v.state(),fontRequests:JSON.parse(v.doc.fontRequests()),fontsUsed:v.getDocumentInfo().fontsUsed,semantic:{pages,paragraphs},serialized:Array.from(v.serialize(false)),shellRevision:window.__documentState.captureRevision()};
  });
  const bytes=Buffer.from(raw.serialized); delete raw.serialized;
  const faces=new Map(),glyphs=new Map();const canonical=structuredClone(raw.semantic);
  for(const packet of canonical.pages){delete packet.glyphs;for(const op of packet.ops){if(op.face!==undefined){const oldFace=op.face;if(!faces.has(oldFace))faces.set(oldFace,faces.size);op.face=faces.get(oldFace);if(!glyphs.has(oldFace))glyphs.set(oldFace,new Map());const map=glyphs.get(oldFace);for(const glyph of op.glyphs){if(!map.has(glyph[0]))map.set(glyph[0],map.size);glyph[0]=map.get(glyph[0]);}}}}
  const file=`${String(doc.sequence++).padStart(3,'0')}-${label.replace(/[^a-z0-9-]/gi,'-')}.json.gz`;
  await fs.writeFile(path.join(doc.dir,file),gzipSync(JSON.stringify(raw)));
  return {state:raw.state,fontRequests:raw.fontRequests,fontsUsed:raw.fontsUsed,semantic:hash(raw.semantic),render:hash(canonical),text:hash(raw.semantic.paragraphs),bytes:hash(bytes),byteLength:bytes.length,shellRevision:raw.shellRevision,evidence:file};
}
const same = (a,b) => { assert.equal(b.semantic,a.semantic,'Native paragraphs/packet ops/lines differ'); };
async function focus(page){await page.focus(inputSelector);}
async function shift(page,key,n=1){await page.keyboard.down('Shift');try{for(let i=0;i<n;i++)await page.keyboard.press(key);}finally{await page.keyboard.up('Shift');}}
async function alt(page,key){await page.keyboard.down('Alt');try{await page.keyboard.press(key);}finally{await page.keyboard.up('Alt');}}
async function textField(page,selector,text){await page.click(selector);await shortcut(page,'a');await page.keyboard.type(String(text));}
async function labeled(page,label,value,scope='[role="dialog"]') {
 const field=await page.evaluate(({label,scope})=>{const l=[...document.querySelectorAll(`${scope} label`)].find(x=>x.textContent===label);if(!l)throw Error(`Missing label ${label}`);const el=document.getElementById(l.htmlFor);return {id:el.id,tag:el.tagName};},{label,scope});
 if(field.tag==='SELECT')await page.select(`#${field.id}`,String(value));else await textField(page,`#${field.id}`,value);
}
async function button(page,text,scope='[role="dialog"]') {
 const buttons=await page.$$(`${scope} button`);for(const b of buttons)if((await b.evaluate(x=>x.textContent))===text&&await b.isVisible()){assert.ok(await b.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit);}),`Button obscured: ${text}`);await b.click();return;}throw Error(`Button missing: ${text}`);
}
async function menu(page,group,cmd){await page.click(`[data-menu="${group}"] > .menu-title`);const selector=`[data-menu="${group}"] .md-item[data-cmd="${cmd}"]`;await page.waitForSelector(selector,{visible:true,timeout:5000});await page.click(selector);await settle(page);}
async function palette(page,cmd){await focus(page);await shortcut(page,'/');await page.waitForSelector('.cp-input',{visible:true,timeout:5000});await page.type('.cp-input',cmd);await page.keyboard.press('Enter');await settle(page);}
async function shot(page,doc,label){await settle(page);const file=`${label}.png`;await page.screenshot({path:path.join(doc.dir,file)});return file;}
async function attempt(page,doc,name,fn){if(!await page.evaluate(()=>window.__wasm?.hasLoadedDocument()))throw new Error('Live document unloaded, likely Vite reload. Remaining checks aborted.');const result={name,status:'running'};doc.checks.push(result);await persist();try{await fn(result);if(result.status==='running')result.status='passed';}catch(e){result.status='failed';result.error=e.stack;result.diagnostics=await page.evaluate(()=>({body:document.body.innerText,loaded:window.__wasm?.hasLoadedDocument(),bold:{disabled:document.querySelector('#btn-bold')?.disabled,toolbar:document.querySelector('#btn-bold')?.closest('.sb-disabled')?.outerHTML.slice(0,1200)},overlays:[...document.querySelectorAll('[data-heemang-overlay]')].map(e=>e.outerHTML),dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.outerHTML)})).catch(e=>({error:e.message}));result.screenshot=await shot(page,doc,`failure-${doc.checks.length}`).catch(()=>null);console.error(`${doc.name}: ${name}: ${e.message}`);log('failure',`${doc.name} ${name}: ${e.stack}`);await page.keyboard.press('Escape').catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});}await persist();return result;}
async function operation(page,doc,label,action,validate,groups=1){
 const before=await native(page,doc,`${label}-before`);await action();await settle(page);const after=await native(page,doc,`${label}-after`);
 assert.ok(after.state.contentEpoch>before.state.contentEpoch,`${label}: no content mutation`);
 assert.equal(after.state.undo,before.state.undo+groups,`${label}: native undo group`);assert.equal(after.state.redo,0);
 assert.notEqual(after.bytes,before.bytes,`${label}: native serialized document did not change`);if(validate)await validate(before,after);
 await focus(page);await shortcut(page,'z');const undo=await native(page,doc,`${label}-undo`);same(before,undo);assert.equal(undo.state.undo,before.state.undo);assert.equal(undo.state.redo,groups);
 await shortcut(page,'z',true);const redo=await native(page,doc,`${label}-redo`);same(after,redo);assert.equal(redo.state.undo,after.state.undo);assert.equal(redo.state.redo,0);
 return {before,after,undo,redo,packetChanged:before.semantic!==after.semantic,undoByteIdentity:before.bytes===undo.bytes};
}
async function sample(page,range){return page.evaluate(range=>window.__wasm.viewer.copyText(range),range);}
async function selectSafe(page,cell){const t=await clickText(page,cell);await shift(page,'ArrowRight',3);return {...t,range:{from:t.at,to:{...t.at,offset:t.at.offset+3}}};}
async function formatFlow(page,doc,cell){
 let target;
 const bold=await attempt(page,doc,`${cell?'cell':'body'} toolbar bold explicit on/off`,async r=>{
   target=await selectSafe(page,cell);r.target=target;
   const beforeHTML=await sample(page,target.range);r.beforeHTML=beforeHTML;const runs=[...beforeHTML.html.matchAll(/<span style="([^"]*)">/g)];const boldValue=runs.length&&runs.every(run=>/font-weight:\s*(?:bold|700)/.test(run[1]))?'false':'true';r.explicitValue=boldValue;
   r.history=await operation(page,doc,`bold-${cell}`,async()=>{await page.click('#btn-bold');await page.waitForSelector('[role="dialog"][aria-label="글자 모양"]',{visible:true,timeout:5000});r.dialogBefore=await shot(page,doc,`bold-${cell}-dialog-before`);await labeled(page,'진하게',boldValue);await button(page,'적용');await page.waitForSelector('.modal-overlay',{hidden:true});r.dialogAfter=await shot(page,doc,`bold-${cell}-dialog-after`);},async()=>{
     r.afterHTML=await sample(page,target.range);assert.equal(/font-weight:\s*(?:bold|700)/.test(r.afterHTML.html),boldValue==='true');assert.equal(r.afterHTML.text,beforeHTML.text);
     assert.ok(await page.$$eval('[data-heemang-overlay]>div',els=>els.some(e=>!e.dataset.heemangCaret&&parseFloat(e.style.width)>0)),'Formatting lost selection');
   });
 });
 if(bold.status!=='passed')throw new Error('First bold UI flow failed. Remaining checks stopped; inspect modal diagnostics.');
 await attempt(page,doc,`${cell?'cell':'body'} full character dialog`,async r=>{
   target=await selectSafe(page,cell);
   r.history=await operation(page,doc,`char-${cell}`,async()=>{await alt(page,'l');await page.waitForSelector('[role="dialog"][aria-label="글자 모양"]',{visible:true,timeout:5000});r.dialogBefore=await shot(page,doc,`char-${cell}-dialog-before`);await labeled(page,'진하게','false');await labeled(page,'기울임','true');await labeled(page,'밑줄','true');await labeled(page,'크기 (pt)','13.25');await labeled(page,'글자 색','#b12345');r.dialogFilled=await shot(page,doc,`char-${cell}-dialog-filled`);await button(page,'적용');await page.waitForSelector('.modal-overlay',{hidden:true});r.dialogAfter=await shot(page,doc,`char-${cell}-dialog-after`);},async()=>{r.html=await sample(page,target.range);assert.match(r.html.html,/13.25pt/);assert.match(r.html.html,/#b12345/i);assert.match(r.html.html,/font-style:\s*italic/);assert.match(r.html.html,/underline/);});
   doc.styleRanges.push(target.range);
 });
 await attempt(page,doc,`${cell?'cell':'body'} paragraph dialog`,async r=>{
   target=await selectSafe(page,cell);
   r.history=await operation(page,doc,`para-${cell}`,async()=>{await alt(page,'t');await page.waitForSelector('[role="dialog"][aria-label="문단 모양"]',{visible:true,timeout:5000});r.dialogBefore=await shot(page,doc,`para-${cell}-dialog-before`);for(const [k,v]of [['정렬','center'],['들여쓰기 (pt)','3'],['왼쪽 여백 (pt)','4'],['문단 위 (pt)','2'],['문단 아래 (pt)','5'],['줄 간격 (%)','175']])await labeled(page,k,v);r.dialogFilled=await shot(page,doc,`para-${cell}-dialog-filled`);await button(page,'적용');await page.waitForSelector('.modal-overlay',{hidden:true});r.dialogAfter=await shot(page,doc,`para-${cell}-dialog-after`);},async()=>{r.html=await sample(page,target.range);/* Paragraph styles are verified by operation packet changes and exact undo/redo. */});
 });
 await attempt(page,doc,`${cell?'cell':'body'} toolbar size and line spacing`,async r=>{
   await selectSafe(page,cell);r.size=await operation(page,doc,`size-${cell}`,async()=>{await textField(page,'#font-size','14');await page.keyboard.press('Enter');});
   await selectSafe(page,cell);r.spacing=await operation(page,doc,`spacing-${cell}`,()=>page.select('#linespacing-select','180'));
 });
 await attempt(page,doc,`${cell?'cell':'body'} dialog cancellation`,async r=>{await selectSafe(page,cell);r.before=await native(page,doc,'cancel-before');await alt(page,'l');await page.waitForSelector('[role="dialog"][aria-label="글자 모양"]',{visible:true,timeout:5000});await labeled(page,'크기 (pt)','40');await button(page,'취소');r.after=await native(page,doc,'cancel-after');same(r.before,r.after);assert.deepEqual(r.after.state,r.before.state);});
}
async function clipboardAction(page,type){
 const index=await page.evaluate(()=>window.__slice2ClipboardEvents.length);
 await shortcut(page,{copy:'c',cut:'x',paste:'v'}[type]);
 await page.waitForFunction(({index,type})=>window.__slice2ClipboardEvents.slice(index).some(e=>e.type===type),{timeout:800},{index,type}).catch(()=>{});
 const observed=await page.evaluate(({index,type})=>window.__slice2ClipboardEvents.slice(index).find(e=>e.type===type),{index,type});
 if(observed){if(type!=='paste')await page.evaluate(observed=>{const data=new DataTransfer();if(observed.text)data.setData('text/plain',observed.text);if(observed.html)data.setData('text/html',observed.html);window.__slice2Clipboard=data;},observed);return {boundary:'Real Chrome keyboard clipboard event',observed};}
 const synthetic=await page.$eval(inputSelector,(el,type)=>{
   const data=type==='paste'?(window.__slice2ExternalClipboard||window.__slice2Clipboard||new DataTransfer()):new DataTransfer();
   const event=new ClipboardEvent(type,{bubbles:true,cancelable:true,clipboardData:data});el.dispatchEvent(event);
   if(type!=='paste')window.__slice2Clipboard=data;
   return {type,isTrusted:event.isTrusted,types:[...data.types],text:data.getData('text/plain'),html:data.getData('text/html')};
 },type);
 return {boundary:'SYNTHETIC ClipboardEvent/DataTransfer: real Chrome keyboard emitted no clipboard event in headless mode',synthetic};
}
async function menuClipboardAction(page,type){
 const index=await page.evaluate(()=>window.__slice2ClipboardIO.length);
 await focus(page);await menu(page,'edit',`edit:${type}`);
 const expected=type==='paste'?'read':'write';
 await page.waitForFunction(({index,expected})=>window.__slice2ClipboardIO.slice(index).some(e=>e.method===expected&&e.status==='complete'),{timeout:10000},{index,expected});
 await settle(page);
 const io=await page.evaluate(index=>window.__slice2ClipboardIO.slice(index),index);
 if(type!=='paste'||!await page.evaluate(()=>document.body.innerText.includes('HTML 클립보드 가져오기')))await page.waitForFunction(()=>document.activeElement?.matches('textarea[data-heemang-input]'),{timeout:10000});
 return {boundary:'REAL Edit menu -> production navigator.clipboard.write/read; browser/OS clipboard, no synthetic event',type,io};
}
async function menuSourceStyle(page,doc,cell){
 await attempt(page,doc,`${cell?'cell':'body'} styled source for real menu clipboard`,async r=>{
   const target=await selectSafe(page,cell);r.target=target;
   r.history=await operation(page,doc,`menu-source-${cell}`,async()=>{await menu(page,'format','format:char-shape');await page.waitForSelector('[role="dialog"][aria-label="글자 모양"]',{visible:true,timeout:5000});await labeled(page,'기울임','true');await labeled(page,'밑줄','true');await labeled(page,'크기 (pt)','13.25');await labeled(page,'글자 색','#b12345');r.dialog=await shot(page,doc,`menu-source-${cell}-dialog`);await button(page,'적용');},async()=>{r.html=await sample(page,target.range);assert.match(r.html.html,/13.25pt/);assert.match(r.html.html,/#b12345/i);});
   doc.styleRanges.push(target.range);
 });
}
async function htmlCharacters(page,html){return page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');return [...d.querySelectorAll('span')].flatMap(e=>[...e.textContent].map(char=>({char,style:e.getAttribute('style')})));},html);}
async function clipboardFlow(page,doc,cell,boundary='keyboard'){
 const action=type=>boundary==='menu'?menuClipboardAction(page,type):clipboardAction(page,type);
 await attempt(page,doc,`${cell?'cell':'body'} ${boundary} internal copy/paste styles`,async r=>{
   const t=await selectSafe(page,cell);r.original=await sample(page,t.range);
   r.copy=await action('copy');await page.keyboard.press('ArrowRight');
   const at={...t.at,offset:t.at.offset+4};
   r.history=await operation(page,doc,`clipboard-internal-${cell}`,async()=>{r.paste=await action('paste');},async()=>{r.pasted=await sample(page,{from:at,to:{...at,offset:at.offset+3}});assert.equal(r.pasted.text,r.original.text);assert.deepEqual(await htmlCharacters(page,r.pasted.html),await htmlCharacters(page,r.original.html),'Internal clipboard lost style');});r.boundary={copy:r.copy.boundary,paste:r.paste.boundary};
 });
 await attempt(page,doc,`${cell?'cell':'body'} ${boundary} cut`,async r=>{const t=await selectSafe(page,cell);r.history=await operation(page,doc,`cut-${cell}`,async()=>{r.cut=await action('cut');});r.boundary=r.cut.boundary;});
 await attempt(page,doc,`${cell?'cell':'body'} selected plain clipboard replacement`,async r=>{
   const t=await selectSafe(page,cell);await page.evaluate(async()=>{await navigator.clipboard.writeText('PLAIN2');const data=new DataTransfer();data.setData('text/plain','PLAIN2');window.__slice2ExternalClipboard=data;});
   r.history=await operation(page,doc,`plain-paste-${cell}`,async()=>{r.paste=await action('paste');},async()=>{r.pasted=await sample(page,{from:t.at,to:{...t.at,offset:t.at.offset+6}});assert.equal(r.pasted.text,'PLAIN2');});r.boundary=r.paste.boundary;await page.evaluate(()=>{window.__slice2ExternalClipboard=null;});
 });
 await attempt(page,doc,`${cell?'cell':'body'} external HTML paste rejected`,async r=>{
   await selectSafe(page,cell);await page.evaluate(async()=>{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob(['external'],{type:'text/plain'}),'text/html':new Blob(['<b>external</b>'],{type:'text/html'})})]);const data=new DataTransfer();data.setData('text/plain','external');data.setData('text/html','<b>external</b>');window.__slice2ExternalClipboard=data;});
   r.before=await native(page,doc,'external-before');r.paste=await action('paste');await page.waitForFunction(()=>document.body.innerText.includes('HTML 클립보드 가져오기'),{timeout:5000});r.after=await native(page,doc,'external-after');same(r.before,r.after);assert.deepEqual(r.after.state,r.before.state);r.screenshot=await shot(page,doc,`html-stub-${cell}`);await page.evaluate(()=>{window.__slice2ExternalClipboard=null;});
 });
}
async function assertUISelection(page,range){
 await settle(page);
 const evidence=await page.evaluate(range=>{
   const v=window.__wasm.viewer,rects=v.select(range);
   const expected=rects.map(r=>{const canvas=document.querySelector(`canvas[data-heemang-page="${r.page}"]`);if(!canvas)throw Error('Selected page not mounted');const scale=canvas.getBoundingClientRect().width/window.__wasm.getPageInfo(r.page).width/75;return {page:r.page,x:r.x*scale,y:r.y*scale,width:r.width*scale,height:r.height*scale};});
   const actual=[...document.querySelectorAll('[data-heemang-overlay]>div')].filter(e=>!e.dataset.heemangCaret&&parseFloat(e.style.width)>0).map(e=>({page:Number(e.parentElement.dataset.heemangOverlay),x:parseFloat(e.style.left),y:parseFloat(e.style.top),width:parseFloat(e.style.width),height:parseFloat(e.style.height)}));
   return {range,expected,actual};
 },range);
 assert.equal(evidence.actual.length,evidence.expected.length,'Selection rectangle count');
 for(let i=0;i<evidence.expected.length;i++){assert.equal(evidence.actual[i].page,evidence.expected[i].page);for(const key of ['x','y','width','height'])assert.ok(Math.abs(evidence.actual[i][key]-evidence.expected[i][key])<0.02,`Selection ${key} does not match expected native address`);}
 return evidence;
}
async function finalAdjacentFlow(page,doc){
 for(const close of await page.$$('.rhwp-toast-close'))if(await close.isVisible())await close.click();await page.waitForFunction(()=>!document.querySelector('.rhwp-toast'),{timeout:3000});
 let target,first,second;
 const navigation=await attempt(page,doc,'final adjacent find caret-start, next, previous and wrap',async r=>{
   assert.equal(await page.evaluate(()=>window.__wasm.viewer.search('qZ',true).matches.length),0,'qZ must be unique to this verification');
   target=await clickText(page,false);r.target=target;
   await page.keyboard.type('qZqZ');for(let i=0;i<4;i++)await page.keyboard.press('ArrowLeft');
   r.nativeMatches=await page.evaluate(()=>window.__wasm.viewer.search('qZ',true));assert.equal(r.nativeMatches.matches.length,2,'Native query must expose exactly the adjacent pair');
   first={from:target.at,to:{...target.at,offset:target.at.offset+2}};second={from:{...target.at,offset:target.at.offset+2},to:{...target.at,offset:target.at.offset+4}};
   const before=await native(page,doc,'adjacent-find-before');
   await menu(page,'edit','edit:find-replace');await page.waitForSelector('.find-dialog',{visible:true,timeout:5000});await labeled(page,'찾을 내용:','qZ','.find-dialog');await labeled(page,'바꿀 내용:','xY','.find-dialog');await page.click('.find-dialog input[type="checkbox"]');
   r.steps=[];
   for(const [label,text,expected]of [['caret-start inclusive','다음 찾기',first],['adjacent next','다음 찾기',second],['previous','이전 찾기',first],['previous wrap','이전 찾기',second],['next wrap','다음 찾기',first]]){
     await button(page,text,'.find-dialog');r.steps.push({name:label,selection:await assertUISelection(page,expected),dialog:await page.evaluate(()=>({inputs:[...document.querySelectorAll('.find-dialog input')].map(e=>({type:e.type,value:e.value,checked:e.checked})),status:document.querySelector('.find-dialog-status')?.textContent,overlays:[...document.querySelectorAll('[data-heemang-overlay]')].map(e=>e.outerHTML)})),searchCalls:await page.evaluate(()=>window.__slice2SearchCalls?.slice(-2)||[]),screenshot:await shot(page,doc,`final-find-${label.replaceAll(' ','-')}`)});
   }
   r.after=await native(page,doc,'adjacent-find-after');same(before,r.after);assert.deepEqual(r.after.state,before.state);await button(page,'×','.find-dialog');
 });
 if(navigation.status!=='passed')throw Error('Final adjacent navigation failed; stopping dependent replacement checks');
 await attempt(page,doc,'final first Replace without live match only finds caret-start hit',async r=>{
   await focus(page);await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
   r.before=await native(page,doc,'replace-prime-before');await menu(page,'edit','edit:find-replace');await page.waitForSelector('.find-dialog',{visible:true,timeout:5000});await labeled(page,'찾을 내용:','qZ','.find-dialog');await labeled(page,'바꿀 내용:','xY','.find-dialog');await page.click('.find-dialog input[type="checkbox"]');
   await button(page,'바꾸기','.find-dialog');r.selection=await assertUISelection(page,first);r.after=await native(page,doc,'replace-prime-after');same(r.before,r.after);assert.deepEqual(r.after.state,r.before.state);r.screenshot=await shot(page,doc,'final-replace-prime');
 });
 await attempt(page,doc,'final replace first adjacent hit selects next; exact undo redo',async r=>{
   r.history=await operation(page,doc,'final-replace-first',()=>button(page,'바꾸기','.find-dialog'),async()=>{r.selection=await assertUISelection(page,second);const text=await page.evaluate(t=>window.__wasm.viewer.getParagraphText(t.at.section,t.at.para,t.at.steps),target);assert.ok(text.includes('xYqZ'));r.screenshot=await shot(page,doc,'final-replace-first-next-selected');});
 });
 await attempt(page,doc,'final replace next adjacent hit; exact undo redo',async r=>{
   await button(page,'다음 찾기','.find-dialog');r.selection=await assertUISelection(page,second);
   r.history=await operation(page,doc,'final-replace-second',()=>button(page,'바꾸기','.find-dialog'),async()=>{const text=await page.evaluate(t=>window.__wasm.viewer.getParagraphText(t.at.section,t.at.para,t.at.steps),target);assert.ok(text.includes('xYxY'));assert.ok(!text.includes('qZ'));r.screenshot=await shot(page,doc,'final-replaced-both');});
   await button(page,'×','.find-dialog');doc.markers.push({list:target.list,para:target.at.para,text:'xYxY'});
 });
}
async function findFlow(page,doc,cell){
 const marker=cell?'S2CELLQ':'S2BODYQ',replacement=cell?'S2CELLR':'S2BODYR';
 await attempt(page,doc,`${cell?'cell':'body'} find and replace`,async r=>{
   const t=await clickText(page,cell);await page.keyboard.type(marker);await settle(page);r.target=t;
   await shortcut(page,'f');await page.waitForSelector('.find-dialog',{visible:true,timeout:5000});await labeled(page,'찾을 내용:',marker,'.find-dialog');await button(page,'다음 찾기','.find-dialog');await button(page,'이전 찾기','.find-dialog');r.find=await shot(page,doc,`find-${cell}`);await page.keyboard.press('Escape');
   await focus(page);await menu(page,'edit','edit:find-replace');await page.waitForSelector('.find-dialog',{visible:true,timeout:5000});await labeled(page,'찾을 내용:',marker,'.find-dialog');await labeled(page,'바꿀 내용:',replacement,'.find-dialog');await button(page,'다음 찾기','.find-dialog');r.dialogBefore=await shot(page,doc,`replace-${cell}-before`);
   r.history=await operation(page,doc,`replace-${cell}`,async()=>{await button(page,'바꾸기','.find-dialog');r.dialogAfter=await shot(page,doc,`replace-${cell}-after`);await button(page,'×','.find-dialog');},async()=>{const text=await page.evaluate(t=>window.__wasm.viewer.getParagraphText(t.at.section,t.at.para,t.at.steps),t);assert.ok(text.includes(replacement));assert.ok(!text.includes(marker));});doc.markers.push({list:t.list,para:t.at.para,text:replacement});
 });
}
async function replaceAllFlow(page,doc){
 await attempt(page,doc,'replace all across body and table cell',async r=>{
   assert.equal(doc.markers.length,2,'Both single-replace markers must exist first');
   await focus(page);await menu(page,'edit','edit:find-replace');await page.waitForSelector('.find-dialog',{visible:true,timeout:5000});
   await labeled(page,'찾을 내용:','S2','.find-dialog');await labeled(page,'바꿀 내용:','S3','.find-dialog');
   r.history=await operation(page,doc,'replace-all',async()=>{await button(page,'모두 바꾸기','.find-dialog');r.message=await page.$eval('.find-dialog-status',e=>e.textContent);assert.equal(r.message,'2개 바꿈');r.screenshot=await shot(page,doc,'replace-all');await button(page,'×','.find-dialog');},async()=>{
     for(const m of doc.markers){const text=await page.evaluate(m=>window.__wasm.viewer.getParagraphText(m.list.section,m.para,m.list.steps),m);assert.ok(text.includes(m.text.replace('S2','S3')));}
   });
   for(const m of doc.markers)m.text=m.text.replace('S2','S3');
 });
}
async function crossCellFlow(page,doc){
 await attempt(page,doc,'unsupported cross-cell selection',async r=>{
   const first=await clickText(page,true);let second;try{second=await clickText(page,true,first.list);}catch(error){if(!error.message.includes('No safe cell text line found'))throw error;r.status='skipped';r.reason='No second independently safe table cell target';return;}
   if(first.page!==second.page){r.status='skipped';r.reason='Safe targets lie on different pages; no cross-page drag attempted';return;}
   const coords=await page.evaluate(ts=>ts.map(t=>{const c=document.querySelector(`canvas[data-heemang-page="${t.page}"]`),rect=c.getBoundingClientRect(),p=window.__wasm.viewer.page(t.page);return{x:rect.x+t.hu.x/p.width*rect.width,y:rect.y+t.hu.y/p.height*rect.height};}),[first,second]);
   if(coords.some(p=>p.y<150||p.y>1150||p.x<0||p.x>1440)){r.status='skipped';r.reason='Safe cell targets cannot both fit current viewport';return;}
   r.before=await native(page,doc,'cross-cell-before');await page.mouse.move(coords[0].x,coords[0].y);await page.mouse.down();await page.mouse.move(coords[1].x,coords[1].y,{steps:8});await page.mouse.up();
   await page.waitForFunction(()=>document.body.innerText.includes('서로 다른 문단 목록 사이의 선택'),{timeout:5000});r.after=await native(page,doc,'cross-cell-after');same(r.before,r.after);assert.deepEqual(r.after.state,r.before.state);r.screenshot=await shot(page,doc,'cross-cell-rejected');
 });
}
async function dismissToasts(page){
 for(const close of await page.$$('.rhwp-toast-close'))if(await close.isVisible())await close.click();
 await page.waitForFunction(()=>!document.querySelector('.rhwp-toast'),{timeout:3000});
}
async function additionalStubs(page,doc){
 for(const command of ['table:delete-row','table:delete-col','format:toggle-bullet','format:apply-style','format:char-spacing-decrease']){
   await attempt(page,doc,`final unsupported ${command}`,async r=>{
     await dismissToasts(page);const target=command.startsWith('table:')?await clickText(page,true):await selectSafe(page,false);r.target=target;
     r.command=command;r.boundary='Actual command-palette keyboard search and Enter; no direct dispatch';r.before=await native(page,doc,`${command}-before`);
     await palette(page,command);await page.waitForFunction(command=>[...document.querySelectorAll('.rhwp-toast-message')].some(e=>e.textContent.includes(command)&&e.textContent.includes('지원하지 않는')),{timeout:5000},command);
     r.message=await page.$$eval('.rhwp-toast-message',els=>els.map(e=>e.textContent));r.after=await native(page,doc,`${command}-after`);same(r.before,r.after);assert.equal(r.after.bytes,r.before.bytes,'Stub changed serialized bytes');assert.deepEqual(r.after.state,r.before.state,'Stub changed native state/history');r.screenshot=await shot(page,doc,command.replaceAll(':','-'));r.errorCode='ENGINE_NOT_SUPPORTED inferred from production error message';
   });
 }
 await attempt(page,doc,'final unsupported cross-cell Shift-click across any pages',async r=>{
   await dismissToasts(page);r.first=await clickText(page,true);r.before=await native(page,doc,'cross-shift-before');
   try{r.second=await clickText(page,true,r.first.list,true);}catch(error){if(!error.message.includes('No safe cell text line found'))throw error;r.status='skipped';r.reason='No second native non-object table-cell caret target found';return;}
   r.boundary='Real Shift-click; native locate validates both cell caret stops; no adapter selection mutation';
   await page.waitForFunction(()=>[...document.querySelectorAll('.rhwp-toast-message')].some(e=>e.textContent.includes('서로 다른 문단 목록 사이의 선택')),{timeout:5000});r.after=await native(page,doc,'cross-shift-after');same(r.before,r.after);assert.equal(r.after.bytes,r.before.bytes);assert.deepEqual(r.after.state,r.before.state);r.screenshot=await shot(page,doc,'cross-cell-shift-rejected');
 });
}
async function unsupported(page,doc){
 for(const [name,action,term]of [
 ['caret character formatting',async()=>{await clickText(page,false);await page.click('#btn-bold');},'캐럿'],
 ['strike',async()=>{await selectSafe(page,false);await page.click('#btn-strike');},'format:strikethrough'],
 ['font',async()=>{await selectSafe(page,false);await page.select('#font-name','돋움');},'font'],
 ['character spacing',()=>palette(page,'format:char-spacing-increase'),'format:char-spacing-increase'],
 ['style',()=>palette(page,'format:style-dialog'),'format:style-dialog'],
 ['list',()=>palette(page,'format:toggle-numbering'),'format:toggle-numbering'],
 ['table row',async()=>{await clickText(page,true);await palette(page,'table:insert-row-above');},'table:insert-row-above'],
 ['table column',()=>palette(page,'table:insert-col-left'),'table:insert-col-left'],
 ['table merge',()=>palette(page,'table:cell-merge'),'table:cell-merge'],
 ['table split',()=>palette(page,'table:cell-split'),'table:cell-split']
 ]) await attempt(page,doc,`unsupported ${name}`,async r=>{
   r.before=await native(page,doc,`unsupported-${name}-before`);await action();
   await page.waitForFunction(term=>document.body.innerText.includes(term)&&document.body.innerText.includes('지원하지 않는'),{timeout:4000},term);r.message=await page.evaluate(()=>document.body.innerText.split('\n').filter(x=>x.includes('지원하지 않는')));r.after=await native(page,doc,`unsupported-${name}-after`);same(r.before,r.after);assert.equal(r.after.state.undo,r.before.state.undo);assert.equal(r.after.state.redo,r.before.state.redo);assert.equal(r.after.state.contentEpoch,r.before.state.contentEpoch);r.errorCode='ENGINE_NOT_SUPPORTED inferred from production EngineNotSupportedError message';
 });
}
async function saveReopen(page,doc){
 await attempt(page,doc,'same-format File menu save and reopen',async r=>{
   if(fontDiagnostic){r.fontDiagnostic={boundary:'EXPLICIT DIAGNOSTIC: user-authorized prepareFonts, not a UI edit or gate pass'};r.fontDiagnostic.before=await native(page,doc,'font-diagnostic-before');await clickText(page,false);r.fontDiagnostic.beforeScreenshot=await shot(page,doc,'font-diagnostic-before');await page.evaluate(async()=>{const v=window.__wasm.viewer;await v.prepareFonts(v.getDocumentInfo().fontsUsed,{});window.__eventBus.emit('document-layout-refreshed');});await settle(page);r.fontDiagnostic.after=await native(page,doc,'font-diagnostic-after');r.fontDiagnostic.afterScreenshot=await shot(page,doc,'font-diagnostic-after');}
   const styles=await Promise.all(doc.styleRanges.map(range=>sample(page,range)));r.stylesBefore=styles;
   const before=await native(page,doc,'save-before');await menu(page,'file','file:save');
   await page.waitForFunction(()=>window.__slice2Saved?.length>0,{timeout});await page.waitForFunction(()=>!window.__wasm.viewer.state().dirty,{timeout});
   const saved=await page.evaluate(()=>window.__slice2Saved.at(-1));const bytes=await fs.readFile(saved.path);r.saved=saved;
   assert.ok(bytes.subarray(0,8).equals(doc.source.subarray(0,8)),'Container format changed');const after=await native(page,doc,'save-after');same(before,after);assert.equal(after.state.undo,before.state.undo);assert.equal(after.state.contentEpoch,before.state.contentEpoch);
   await open(page,bytes,doc.name);r.reopened=await native(page,doc,'reopened');r.stylesAfter=await Promise.all(doc.styleRanges.map(range=>sample(page,range)));await clickText(page,false);r.bodyScreenshot=await shot(page,doc,'reopened-body-formatting');await clickText(page,true);r.cellScreenshot=await shot(page,doc,'reopened-cell-formatting');assert.equal(r.reopened.text,before.text,'Reopened paragraph text differs');assert.equal(r.reopened.render,before.render,'Reopened native geometry/styles differ after normalizing runtime face/glyph IDs');assert.equal(r.reopened.bytes,hash(bytes),'Reopened native serialization differs from saved file');
   for(const marker of doc.markers){const text=await page.evaluate(m=>window.__wasm.viewer.getParagraphText(m.list.section,m.para,m.list.steps),marker);assert.ok(text.includes(marker.text),`Missing saved marker ${marker.text}`);}
   for(let i=0;i<styles.length;i++)assert.deepEqual(await htmlCharacters(page,r.stylesAfter[i].html),await htmlCharacters(page,styles[i].html),'Saved character styles changed');r.screenshot=await shot(page,doc,'reopened');
 });
}
await fs.mkdir(path.join(out,'docs'),{recursive:true});await fs.mkdir(run,{recursive:true});
for(const name of names){const target=path.join(out,'docs',name);await fs.rm(target,{force:true});await fs.copyFile(path.join('/Users/pyu/projects/hobbies/Rau/heemang-cleanroom/parity/docs',name),target);await fs.chmod(target,0o644);}
let browser;
try{
 ensureChromePath();browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,protocolTimeout:180000,args:['--disable-dev-shm-usage']});
 await browser.defaultBrowserContext().overridePermissions('http://127.0.0.1:7700',['clipboard-read','clipboard-write','clipboard-sanitized-write']);
 for(const name of names){
   const doc={name,dir:path.join(run,path.parse(name).name),status:'running',sequence:0,checks:[],styleRanges:[],markers:[],errors:[]};results.documents.push(doc);await fs.mkdir(doc.dir,{recursive:true});
   const page=await browser.newPage();await page.setViewport({width:1440,height:1200,deviceScaleFactor:1});
   page.on('pageerror',e=>{doc.errors.push(e.stack);log('pageerror',`${name}: ${e.stack}`);});page.on('console',m=>log(`console.${m.type()}`,`${name}: ${m.text()}`));page.on('dialog',d=>{log('dialog',d.message());void d.dismiss();});
   await page.exposeFunction('__slice2Write',async(base64,suggestedName)=>{const target=path.join(doc.dir,`saved-${path.basename(suggestedName||name)}`);const bytes=Buffer.from(base64,'base64');await fs.writeFile(target,bytes);return {path:target,bytes:bytes.length};});
   await page.evaluateOnNewDocument(()=>{
     window.__slice2Saved=[];window.__slice2ClipboardIO=[];for(const method of ['write','read','writeText']){const original=navigator.clipboard[method].bind(navigator.clipboard);navigator.clipboard[method]=async(...args)=>{const record={method,status:'started',time:performance.now()};window.__slice2ClipboardIO.push(record);try{const result=await original(...args);record.status='complete';record.finished=performance.now();return result;}catch(error){record.status='failed';record.error=error.message;throw error;}};}window.__slice2ClipboardEvents=[];for(const type of ['copy','cut','paste'])document.addEventListener(type,event=>{const record={type,isTrusted:event.isTrusted,time:performance.now()};window.__slice2ClipboardEvents.push(record);queueMicrotask(()=>Object.assign(record,{types:[...event.clipboardData.types],text:event.clipboardData.getData('text/plain'),html:event.clipboardData.getData('text/html')}));},true);
     Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async options=>{
       const name=options?.suggestedName||'saved.hwpx';let savedBlob;
       return {kind:'file',name,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',getFile:async()=>new File([savedBlob||''],name),createWritable:async()=>({write:async data=>{savedBlob=data instanceof Blob?data:new Blob([data]);},close:async()=>{const bytes=new Uint8Array(await savedBlob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));window.__slice2Saved.push(await window.__slice2Write(btoa(binary),name));},abort:async()=>{}})};
     }});
   });
   try{
     await page.goto(url,{waitUntil:'networkidle0',timeout});await page.waitForFunction(()=>window.__canvasView&&window.__eventBus&&window.__wasm?.viewer,{timeout});
     Object.defineProperty(doc,'source',{value:await fs.readFile(path.join(out,'docs',name)),configurable:true});await open(page,doc.source,name);await clickText(page,false);await shot(page,doc,'before');
     if(stubsOnly){await additionalStubs(page,doc);}else if(searchTrace){await page.evaluate(()=>{const v=window.__wasm.viewer,original=v.search.bind(v);window.__slice2SearchCalls=[];v.search=(...args)=>{const result=original(...args);window.__slice2SearchCalls.push({time:performance.now(),args:structuredClone(args),result:structuredClone(result),dialogInputs:[...document.querySelectorAll('.find-dialog input')].map(e=>({type:e.type,value:e.value,checked:e.checked})),status:document.querySelector('.find-dialog-status')?.textContent});return result;};});await finalAdjacentFlow(page,doc);doc.searchCalls=await page.evaluate(()=>window.__slice2SearchCalls);await fs.writeFile(path.join(run,'search-trace.json'),JSON.stringify({boundary:'Read-only search wrapper logs arguments/results and returns original result unchanged; all selection and edits through UI.',calls:doc.searchCalls},null,2));}else if(targetedFinal){await menuSourceStyle(page,doc,false);await clipboardFlow(page,doc,false,'menu');await finalAdjacentFlow(page,doc);await menuSourceStyle(page,doc,false);await menuSourceStyle(page,doc,true);await saveReopen(page,doc);}else if(fontDiagnostic){await formatFlow(page,doc,false);await formatFlow(page,doc,true);await findFlow(page,doc,false);await findFlow(page,doc,true);await replaceAllFlow(page,doc);await saveReopen(page,doc);}else if(menuOnly){for(const cell of [false,true]){await menuSourceStyle(page,doc,cell);await clipboardFlow(page,doc,cell,'menu');}await saveReopen(page,doc);}else{await formatFlow(page,doc,false);await formatFlow(page,doc,true);
     await clipboardFlow(page,doc,false);await clipboardFlow(page,doc,true);
     await findFlow(page,doc,false);await findFlow(page,doc,true);
     await replaceAllFlow(page,doc);await crossCellFlow(page,doc);await clickText(page,false);await shot(page,doc,'after-body-formatting');await clickText(page,true);await shot(page,doc,'after-cell-formatting');await shot(page,doc,'after');await unsupported(page,doc);await saveReopen(page,doc);}
     doc.status=doc.checks.every(x=>x.status==='passed'||x.status==='skipped')&&!doc.errors.length?(fontDiagnostic?'diagnostic':'passed'):'failed';
   }catch(e){doc.status='failed';doc.failure=e.stack;log('failure',`${name}: ${e.stack}`);await shot(page,doc,'fatal').catch(()=>{});}
   finally{delete doc.source;await page.close();await persist();console.log(`${name}: ${doc.status} (${doc.checks.filter(x=>x.status==='passed').length}/${doc.checks.length})`);}
 }
 results.status=results.documents.every(d=>d.status==='passed')?'passed':results.documents.every(d=>d.status==='diagnostic')?'diagnostic':'failed';
}catch(e){results.status='failed';results.failure=e.stack;}
finally{if(browser)await browser.close();results.finishedAt=new Date().toISOString();await persist();console.log(`Results: ${path.join(run,'results.json')}`);if(results.status!=='passed')process.exitCode=1;}
