/** 실제 브랜치 UI, 구조 병합 작업자, 복합 실행 취소와 저장·재열기 검증. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
process.env.HV_CANDIDATE_VITE_PORT ||= '7721';
const out=L.ensureOut('version-merge');
const app=await L.startApp('candidate',L.candidateRoot,5721);
let browser,page,log;
const report={url:app.url,provider:'fixture-backed local hub; no provider calls',steps:[],errors:[]};
const state=()=>page.evaluate(()=>window.__versionController.getState());
const idle=()=>page.evaluate(()=>window.__versionController.whenIdle());
const text=()=>page.evaluate(()=>window.__wasm.viewer.getParagraphText(0,0));
const versions=async()=>{await page.evaluate(()=>window.__eventBus.emit('versions:open'));await page.waitForSelector('.ag-versions-close',{visible:true});await page.click('.ag-versions-tab[data-tab="branches"]');await page.waitForSelector('.ag-versions-create-branch',{visible:true});};
const closeVersions=async()=>{await page.click('.ag-versions-close');await page.waitForSelector('.ag-versions-close',{hidden:true});};
async function typeAt(offset,value){await page.evaluate(offset=>{window.__inputHandler.moveCursorTo({sectionIndex:0,paragraphIndex:0,charOffset:offset});window.__inputHandler.focus();},offset);await page.keyboard.type(value);await page.waitForFunction(value=>window.__wasm.viewer.getParagraphText(0,0).includes(value),{},value);}
async function prompt(value){await page.waitForSelector('.ag-version-prompt-input',{visible:true});await page.type('.ag-version-prompt-input',value);await page.click('.ag-version-prompt button[type="submit"]');await page.waitForSelector('.ag-version-prompt-overlay',{hidden:true});await idle();}
async function checkpoint(title){await versions();await page.click('.ag-versions-tab[data-tab="history"]');await page.waitForSelector('[aria-label="새 커밋 만들기"]',{visible:true});await page.click('[aria-label="새 커밋 만들기"]');await prompt(title);await closeVersions();}
async function save(name,format){await page.evaluate(()=>{window.__mergeSaved=null;window.showSaveFilePicker=async o=>({kind:'file',name:o.suggestedName,async getFile(){return new File([window.__mergeSaved??''],o.suggestedName);},async createWritable(){return{async write(b){window.__mergeSaved=b;},async close(){}};},async queryPermission(){return'granted';},async requestPermission(){return'granted';}});});await page.evaluate(format=>window.__dispatcher.dispatch(`file:save-as-${format}`),format);await page.waitForFunction(()=>window.__mergeSaved,{timeout:15000});const bytes=await page.evaluate(async()=>[...new Uint8Array(await window.__mergeSaved.arrayBuffer())]);const file=path.join(out,name);fs.writeFileSync(file,Buffer.from(bytes));return file;}
try{
 browser=await L.launchBrowser();({page,log}=await L.newPage(browser));await page.evaluateOnNewDocument(()=>{window.__mergeWorkerErrors=[];const Original=window.Worker;window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data?.type==='error')window.__mergeWorkerErrors.push(e.data);});}};});await L.loadApp(page,app.url);
 await page.evaluate(async()=>{const{userSettings}=await import('/src/core/user-settings.ts');userSettings.setUseHancomGit(true);});
 for(const[format,conflicted]of[['hwp',true],['hwpx',false]]){
  await L.openDocumentFile(page,path.join(L.candidateRoot,'rhwp/rhwp-studio/src/core/hm/blank.hwpx'),{minInk:0});
  await typeAt(0,'Base 한글😀');const initial=await save(`base.${format}`,format);await L.openDocumentFile(page,initial);
  await page.evaluate(()=>window.__versionController.enable());await idle();
  await versions();await page.click('[aria-label="새 브랜치 만들기"]');await prompt(`incoming-${format}`);assert.equal((await state()).activeBranch,`incoming-${format}`);await closeVersions();
  const end=await page.evaluate(()=>window.__wasm.getParagraphLength(0,0));await typeAt(conflicted?0:end,conflicted?'INCOMING:':':INCOMING');await checkpoint('Incoming change');
  await versions();await page.click('[data-branch-name="main"] [data-version-action="switch"]');await idle();await closeVersions();assert.equal((await state()).activeBranch,'main');
  await typeAt(0,'CURRENT:');await checkpoint('Current change');
  const before=await text();const beforeState=await state();const beforeHead=beforeState.branches.find(b=>b.name==='main').headId;
  await versions();await page.click(`[data-branch-name="incoming-${format}"] [data-version-action="merge"]`);await page.waitForSelector('.merge-resolver-window',{visible:true,timeout:30000});
  const groups=await page.$$eval('.merge-conflict-item',n=>n.length);assert.ok(groups>0);
  await page.screenshot({path:path.join(out,`${format}-review.png`)});
  // Closing saves the draft and leaves document bytes/history untouched.
  await page.click('.merge-close-button');await page.waitForSelector('.merge-resolver-window',{hidden:true});assert.equal(await text(),before);await idle();
  const draft=(await state()).mergeDrafts?.[0];
  if(draft)await page.evaluate(id=>window.__versionController.resumeMerge(id),draft.id);else await page.click(`[data-branch-name="incoming-${format}"] [data-version-action="merge"]`);
  await page.waitForSelector('.merge-resolver-window',{visible:true});
  await page.click('.merge-resolver-header-actions button:first-child');
  const unresolved=await page.$$eval('.merge-conflict-item:not(.is-resolved)',nodes=>nodes.map(n=>n.dataset.conflictId));
  for(const id of unresolved){await page.evaluate(id=>document.querySelector(`[data-conflict-id="${CSS.escape(id)}"]`).click(),id);await page.evaluate(()=>[...document.querySelectorAll('.merge-resolution-button')].find(b=>b.textContent.startsWith('✓')).click());}
  await page.waitForFunction(()=>{const b=document.querySelector('.merge-resolver-footer .merge-primary-button');return b&&!b.disabled;},{timeout:30000});await page.click('.merge-resolver-footer .merge-primary-button');await page.waitForSelector('.merge-resolver-window',{hidden:true,timeout:30000});await idle();
  const merged=await text();assert.ok(merged.includes('INCOMING:')||merged.includes(':INCOMING'));if(conflicted)assert.ok(!merged.includes('CURRENT:'));else assert.ok(merged.includes('CURRENT:'));
  const afterState=await state();const afterHead=afterState.branches.find(b=>b.name==='main').headId;assert.notEqual(afterHead,beforeHead);assert.ok(afterState.branches.some(b=>b.name===`incoming-${format}`));
  await closeVersions();await page.evaluate(()=>window.__dispatcher.dispatch('edit:undo'));await idle();assert.equal(await text(),before);assert.equal((await state()).branches.find(b=>b.name==='main').headId,beforeHead);
  await page.evaluate(()=>window.__dispatcher.dispatch('edit:redo'));await idle();assert.equal(await text(),merged);assert.equal((await state()).branches.find(b=>b.name==='main').headId,afterHead);
  const output=await save(`merged.${format}`,format);await L.openDocumentFile(page,output);assert.equal(await text(),merged);await page.screenshot({path:path.join(out,`${format}-reopened.png`)});
  report.steps.push({format,conflicted,groups,beforeHead,afterHead,merged,checks:['branch creation/switch/checkpoint through UI','draft close/resume preserves bytes','resolver choice and native worker materialization','composite Undo/Redo restores bytes and branch refs','save through file command and reopen identical text']});
 }
 assert.deepEqual(log.pageErrors,[]);assert.deepEqual(L.rhwpEngineRequests(log),[]);report.ok=true;
}catch(error){report.ok=false;report.failure=String(error.stack??error);report.diagnostics=await page?.evaluate(()=>({text:window.__wasm?.viewer.getParagraphText(0,0),state:window.__versionController?.getState(),workerErrors:window.__mergeWorkerErrors,dialogs:[...document.querySelectorAll('dialog,.rhwp-toast,.ag-versions-notice,.merge-validation-errors')].filter(e=>e.getClientRects().length).map(e=>e.textContent)})).catch(()=>null);report.console=log?.console;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;
}finally{report.errors=log?.pageErrors??[];fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2));await browser?.close();await app.stop();console.log(JSON.stringify({ok:report.ok,steps:report.steps.length,failure:report.failure}));}
