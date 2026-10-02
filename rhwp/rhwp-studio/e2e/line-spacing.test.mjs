/** Deterministic layout oracle: a no-op format change must fail this test. */
import { runTest, createNewDocument, clickEditArea, typeText, assert, waitForPaint, waitForState, screenshot } from './helpers.mjs';

runTest('Line spacing changes applied values, geometry and pagination', async ({page}) => {
  await createNewDocument(page);await clickEditArea(page);
  await typeText(page,'A wrapped paragraph with enough text to measure line spacing. '.repeat(5));
  const before=await page.evaluate(()=>{
    const w=window.__wasm;return {start:w.getCursorRect(0,0,0),end:w.getCursorRect(0,0,w.getParagraphLength(0,0)),format:w.getParaPropertiesAt(0,0).lineSpacing,text:w.getTextRange(0,0,0,w.getParagraphLength(0,0))};
  });
  assert(before.end.y>before.start.y,'Fixture wraps onto multiple lines');
  await page.$eval('#linespacing-select',el=>el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
  await page.evaluate(()=>{const input=document.querySelector('#linespacing-select').previousElementSibling;input.value='300';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
  await waitForState(page,'applied 300% spacing',()=>window.__wasm.getParaPropertiesAt(0,0).lineSpacing===300);
  const after=await page.evaluate(()=>window.__wasm.getCursorRect(0,0,window.__wasm.getParagraphLength(0,0)));
  assert(after.y>before.end.y,'Increasing spacing moves the last wrapped line strictly downward');
  await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');
  await waitForState(page,'undo restores spacing',value=>window.__wasm.getParaPropertiesAt(0,0).lineSpacing===value,before.format);
  const undone=await page.evaluate(()=>window.__wasm.getCursorRect(0,0,window.__wasm.getParagraphLength(0,0)));
  assert(Math.abs(undone.y-before.end.y)<0.1,'Undo restores the layout, not just the select label');
  assert(await page.evaluate(()=>window.__wasm.getTextRange(0,0,0,window.__wasm.getParagraphLength(0,0)))===before.text,'Formatting and undo preserve the text');
  const counts=await page.evaluate(()=>{
    const w=window.__wasm;
    for(let i=1;i<40;i++){w.insertParagraph(0,i);w.insertText(0,i,0,`Pagination fixture ${i}`);}
    for(let i=0;i<40;i++)w.applyParaFormat(0,i,JSON.stringify({lineSpacing:100}));
    const tight=w.pageCount;
    for(let i=0;i<40;i++)w.applyParaFormat(0,i,JSON.stringify({lineSpacing:500}));
    window.__eventBus.emit('document-changed');return {tight,wide:w.pageCount};
  });
  assert(counts.wide>counts.tight,`Identical content needs more pages at 500% (${counts.tight} → ${counts.wide})`);
  await waitForPaint(page);await screenshot(page,'line-spacing-pagination');
});
