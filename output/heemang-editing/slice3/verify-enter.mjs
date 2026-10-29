import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from '../../../rhwp/rhwp-studio/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { ensureChromePath } from '../../../rhwp/rhwp-studio/e2e/agent-bench-harness.mjs';
const out=path.dirname(new URL(import.meta.url).pathname),url='http://127.0.0.1:7700/?engine=heemang';
await fs.mkdir(path.join(out,'enter'),{recursive:true});
const source='/Users/pyu/projects/hobbies/Rau/heemang-cleanroom/parity/docs/fdi_q1.hwpx',copy=path.join(out,'enter/fdi_q1.hwpx');
await fs.rm(copy,{force:true});await fs.copyFile(source,copy);await fs.chmod(copy,0o444);
const results={url,source,copy,boundary:'Chrome keyboard Enter; document upload through production file input; native reads only.',checks:[]};
ensureChromePath();const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,protocolTimeout:180000});
let page=await browser.newPage();await page.setViewport({width:1440,height:1200,deviceScaleFactor:1});
page.on('pageerror',e=>(results.errors??=[]).push(e.stack));
try{
await page.goto(url,{waitUntil:'networkidle0'});await page.waitForFunction(()=>window.__wasm?.viewer&&window.__canvasView);
async function open(){const old=await page.evaluate(()=>window.__wasm.documentInstance);await(await page.$('#file-input')).uploadFile(copy);await page.waitForFunction(old=>window.__wasm.documentInstance!==old&&window.__wasm.hasLoadedDocument()&&document.querySelector('canvas[data-heemang-page="0"]')?.width>0,{timeout:120000},old);}
async function settle(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function click(at){
 const c=await page.evaluate(at=>{const v=window.__wasm.viewer;const c=v.locate({kind:'caret',position:at});if(!c)throw Error('no caret for target');return c;},at);
 await page.evaluate(c=>document.getElementById('scroll-container').scrollTop=window.__canvasView.getVirtualScroll().getPageOffset(c.page)+c.y/75-180,c);
 await page.waitForFunction(i=>document.querySelector(`canvas[data-heemang-page="${i}"]`)?.width>0,{},c.page);await settle();
 const point=await page.evaluate(c=>{const canvas=document.querySelector(`canvas[data-heemang-page="${c.page}"]`),b=canvas.getBoundingClientRect(),p=window.__wasm.viewer.page(c.page);return{x:b.left+c.x/p.width*b.width,y:b.top+(c.y+c.height/2)/p.height*b.height};},c);
 await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>document.activeElement?.matches('textarea[data-heemang-input]'),{timeout:5000});return{at,caret:c,point};
}
async function state(list){return page.evaluate(list=>{const v=window.__wasm.viewer,count=v.getParagraphCount(list.section,list.steps),last=v.paragraphs(list.section,list.steps,count-1,1)[0],position={...list,para:count-1,offset:last.caret[1]},caret=v.locate({kind:'caret',position}),el=document.querySelector('[data-heemang-caret]'),rect=el?.getBoundingClientRect(),sc=document.getElementById('scroll-container').getBoundingClientRect();return{state:v.state(),count,last,position,caret,visible:!!rect&&rect.top>=sc.top-1&&rect.bottom<=sc.bottom+1,caretRect:rect?.toJSON(),scrollRect:sc.toJSON(),toasts:[...document.querySelectorAll('.rhwp-toast-message')].map(e=>e.textContent)};},list);}
for(const cell of [false,true]){
 if(cell){await page.close();page=await browser.newPage();await page.setViewport({width:1440,height:1200,deviceScaleFactor:1});await page.goto(url,{waitUntil:'networkidle0'});await page.waitForFunction(()=>window.__wasm?.viewer&&window.__canvasView);}
 await open();const check={name:cell?'100 Enters inside table cell':'100 Enters at end of fdi_q1 section 1',status:'running'};results.checks.push(check);
 const list=await page.evaluate(cell=>{const v=window.__wasm.viewer;if(!cell)return{section:1,steps:[]};for(let i=0;i<v.pageCount;i++)for(const l of v.page(i).lines){if(!l.list.steps.length)continue;const s=l.list.steps[0],p=v.paragraphs(l.list.section,[],s.para,1)[0];if(p.controls.some(c=>c.index===s.control&&c.kind==='table'))return l.list;}throw Error('no table cell');},cell);
 const initial=await state(list);check.clicked=await click(initial.position);check.before=await state(list);await page.screenshot({path:path.join(out,'enter',cell?'cell-before.png':'body-before.png')});
 const samples=[];
 for(let n=1;n<=100;n++){await page.keyboard.press('Enter');if(n%10===0){await settle();samples.push({enters:n,...await state(list)});}}
 await page.waitForFunction(()=>document.querySelector('[data-heemang-caret]'),{timeout:10000});await settle();check.after=await state(list);check.samples=samples;
 check.screenshot=path.join(out,'enter',cell?'cell-after-100.png':'body-after-100.png');await page.screenshot({path:check.screenshot});
 try{assert.equal(check.after.state.contentEpoch-check.before.state.contentEpoch,100);assert.equal(check.after.count-check.before.count,100);assert.ok(check.after.state.pageCount>check.before.state.pageCount,'100 Enters did not add pages');assert.ok(check.after.visible,'caret is outside viewport');assert.ok(check.after.caret.page>check.before.caret.page,'caret did not advance onto a later page');assert.ok(samples.every(s=>s.visible),'caret left viewport at a 10-Enter checkpoint');check.status='passed';}catch(e){check.status='failed';check.failure=e.stack;}
 await fs.writeFile(path.join(out,'enter/results.json'),JSON.stringify(results,null,2));
}
}catch(e){results.failure=e.stack;}finally{results.status=!results.failure&&results.checks.length===2&&results.checks.every(c=>c.status==='passed')?'passed':'failed';await fs.writeFile(path.join(out,'enter/results.json'),JSON.stringify(results,null,2));await browser.close();console.log(JSON.stringify(results.checks.map(c=>({name:c.name,status:c.status,before:c.before?.state,after:c.after?.state,failure:c.failure})),null,2));if(results.status!=='passed'){console.log(results.failure);process.exitCode=1;}}
