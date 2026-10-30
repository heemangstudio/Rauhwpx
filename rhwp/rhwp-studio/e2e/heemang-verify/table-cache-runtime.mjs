/** Real editor/version/save checks. The hub uses the existing offline Pi fixture; latency is not measured. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as L from './lib.mjs';
import {clickPage,openDocument,runMenuCommand,shortcut,waitFor} from '../smoke/lib.mjs';

process.env.HV_CANDIDATE_VITE_PORT ||= '7733';
const out=process.env.HV_OUT || L.ensureOut('table-cache-runtime');
fs.mkdirSync(out,{recursive:true});
const file=path.join(process.env.HV_CORPUS || path.resolve(L.candidateRoot,'../../heemang-cleanroom/parity-corpus/docs'),'d-1341000-research-report-foot-cd72258675b5.hwp');
const mark='TABLE_CACHE_';
const hash=value=>createHash('sha256').update(value).digest('hex');
let app,browser,session;
try {
  app=await L.startApp('candidate',L.candidateRoot,Number(process.env.HV_CANDIDATE_VITE_PORT)+1);
  browser=await L.launchBrowser(); session=await L.newPage(browser);
  const {page,log}=session;
  await L.loadApp(page,app.url); await L.openDocumentFile(page,file);
  await waitFor(page,'version controller',()=>window.__versionController);
  await page.evaluate(async()=>{
    const {buildSnapshotFromWasmInSlices}=await import('/src/compare/diff-engine.ts');
    const {VERSION_COMPARE_OPTIONS}=await import('/src/versioning/snapshot.ts');
    const {HmCore}=await import('/src/core/hm/core.ts');
    const options={...VERSION_COMPARE_OPTIONS,refreshLayout:false},original=HmCore.prototype.tableInfo;
    window.__tableCacheCheck=async label=>{
      const wasm=window.__wasm,before=wasm.viewer.state();
      const revision=window.__documentState.captureRevision(),instance=wasm.documentGeneration;
      const current=()=>revision===window.__documentState.captureRevision() && instance===wasm.documentGeneration;
      const cached=await buildSnapshotFromWasmInSlices(wasm,'research.hwp',options,current);
      let fresh;
      try {
        HmCore.prototype.tableInfo=function(table,page) {return this.query({kind:'table',table,...(page===undefined?{}:{page})});};
        fresh=await buildSnapshotFromWasmInSlices(wasm,'research.hwp',options,current);
      } finally {HmCore.prototype.tableInfo=original;}
      if(!cached || JSON.stringify(cached)!==JSON.stringify(fresh))throw new Error(`${label}: cached/fresh complete snapshot differs`);
      const after=wasm.viewer.state();
      for(const key of ['contentEpoch','layoutEpoch','fontGeneration','dirty','undo','redo'])if(before[key]!==after[key])throw new Error(`${label}: snapshot changed ${key}`);
      let calls=0;
      const cancelled=await buildSnapshotFromWasmInSlices(wasm,'research.hwp',options,()=>++calls<2);
      if(cancelled!==null)throw new Error(`${label}: stale snapshot was published`);
      return {label,json:JSON.stringify(cached),state:after,cancellationChecks:calls};
    };
    await window.__versionController.whenIdle();
    if(!window.__versionController.getState().enabled)await window.__versionController.enable();
  });
  const checks=[];
  const capture=async label=>{
    const result=await page.evaluate(label=>window.__tableCacheCheck(label),label);
    checks.push({label,sha256:hash(result.json),characters:result.json.length,state:result.state,cancellationChecks:result.cancellationChecks});
    return result.json;
  };
  const before=await capture('opened');
  const historyBefore=await page.evaluate(()=>window.__versionController.getState());
  await clickPage(page); await shortcut(page,'Home');
  const cdp=await page.createCDPSession();
  await cdp.send('Input.insertText',{text:mark});
  await waitFor(page,'typed marker',mark=>window.__wasm.getTextRange(0,0,0,100).startsWith(mark),mark);
  const edited=await capture('typed');
  assert.notEqual(edited,before);
  await shortcut(page,'KeyZ');
  await waitFor(page,'undo marker',mark=>!window.__wasm.getTextRange(0,0,0,100).startsWith(mark),mark);
  assert.equal(await capture('undo'),before,'Undo restores the complete version snapshot');
  await shortcut(page,'KeyZ',{shift:true});
  await waitFor(page,'redo marker',mark=>window.__wasm.getTextRange(0,0,0,100).startsWith(mark),mark);
  assert.equal(await capture('redo'),edited,'Redo restores the complete edited snapshot');
  const historyAfter=await page.evaluate(async()=>{
    await window.__versionController.whenIdle();
    await window.__versionController.checkpoint('표 정보 캐시 검증');
    await window.__versionController.whenIdle();
    return window.__versionController.getState();
  });
  assert.ok(historyAfter.commits.length>historyBefore.commits.length,'the real version controller records the edited document');
  await page.evaluate(()=>{
    window.__tableCacheSaved=null;
    window.showSaveFilePicker=async options=>({kind:'file',name:options?.suggestedName??'research.hwp',
      async getFile(){return new File([window.__tableCacheSaved??''],this.name);},
      async createWritable(){return {async write(blob){window.__tableCacheSaved=blob;},async close(){}};},
    });
  });
  await runMenuCommand(page,'파일','file:save');
  await waitFor(page,'saved HWP',()=>window.__tableCacheSaved && !window.__documentState.isDirty());
  const saved=await page.evaluate(async()=>Array.from(new Uint8Array(await window.__tableCacheSaved.arrayBuffer())));
  assert.deepEqual(saved.slice(0,4),[0xd0,0xcf,0x11,0xe0]);
  fs.writeFileSync(path.join(out,'saved.hwp'),new Uint8Array(saved));
  await openDocument(page,saved,'research.hwp');
  assert.equal(await page.evaluate(mark=>window.__wasm.getTextRange(0,0,0,100).startsWith(mark),mark),true);
  assert.equal(await capture('reopened'),edited,'save/reopen preserves the complete edited snapshot');
  assert.deepEqual(log.pageErrors,[]);
  const result={runtime:app.url,fixtureHub:true,latencyMeasured:false,document:{file,sha256:hash(fs.readFileSync(file))},
    checks,versionCommits:{before:historyBefore.commits.length,after:historyAfter.commits.length},savedSha256:hash(new Uint8Array(saved)),pageErrors:log.pageErrors};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await session?.context.close();await L.closeBrowser(browser);await app?.stop();}
