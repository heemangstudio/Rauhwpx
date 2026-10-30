import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rhwpFile } from './heemang-agent-env.ts';
import { compactSfntFace, parseSfntFaces } from '../../rhwp-shared/fonts/font-index-core.mjs';
import { fontGlyphCoverage } from '../src/core/heemang-font-coverage.ts';
const pkg=process.env.HM_WASM_PKG?pathToFileURL(`${process.env.HM_WASM_PKG}/hm_wasm.js`):new URL('../vendor/hm-wasm/hm_wasm.js',import.meta.url);
const {Engine}=await import(pkg.href);
const original=new Uint8Array(readFileSync(new URL('../../../tests/fixtures/fonts/NotoSansKRWebFixture.ttf',import.meta.url)));
const fixture=rhwpFile('rhwp-studio/src/core/hm/blank.hwpx');
const family=(await parseSfntFaces(original)).faces[0].families[0];
const label='fixture.ttf';
const file=(bytes:Uint8Array)=>({size:bytes.length,read:(o:number,n:number)=>bytes.subarray(o,o+n)});
const paras=(doc:any)=>JSON.parse(doc.query(JSON.stringify({kind:'paragraphs',list:{section:0}})));
const svg=(doc:any)=>doc.pageSvg(0,96);
function textDoc(engine:any,text:string){
  const doc=engine.open(fixture),at={section:0,para:0,offset:paras(doc)[0].caret[0]};
  doc.transact(JSON.stringify({ops:[{op:'insertText',at,text},{op:'formatChars',from:at,to:{...at,offset:at.offset+text.length},patch:{fontFace:family}}]}));
  return doc;
}
// 같은 원본 glyph를 비 BMP 문자에도 연결해 휴대 가능한 font로 emoji 범위의 ID 보존을 검사한다.
function emojiAlias(bytes:Uint8Array,glyph:number):Uint8Array{
  const b=Buffer.from(bytes),tables=new Map<string,Buffer>();
  for(let i=0;i<b.readUInt16BE(4);i++){
    const a=12+i*16,start=b.readUInt32BE(a+8);tables.set(b.toString('ascii',a,a+4),Buffer.from(b.subarray(start,start+b.readUInt32BE(a+12))));
  }
  const old=tables.get('cmap')!,n=old.readUInt16BE(2),header=4+n*8;
  const groups:[number,number][]=[];
  const offsets=Array.from({length:n},(_,i)=>old.readUInt32BE(8+i*8));
  const sub=offsets.find(at=>old.readUInt16BE(at)===4)!;
  const segments=old.readUInt16BE(sub+6)/2,end=sub+14,start=end+segments*2+2,delta=start+segments*2,range=delta+segments*2;
  for(let code=0;code<0xffff;code++)for(let i=0;i<segments;i++){
    if(code>old.readUInt16BE(end+i*2))continue;
    if(code>=old.readUInt16BE(start+i*2)){
      const r=old.readUInt16BE(range+i*2),d=old.readInt16BE(delta+i*2);
      let id=r?old.readUInt16BE(range+i*2+r+(code-old.readUInt16BE(start+i*2))*2):(code+d)&0xffff;
      if(r&&id)id=(id+d)&0xffff;if(id)groups.push([code,id]);
    }break;
  }
  groups.push([0x1f600,glyph]);const length=16+groups.length*12,cmap=Buffer.alloc(old.length+8+length);
  old.copy(cmap,0,0,header);cmap.writeUInt16BE(n+1,2);
  for(let i=0;i<n;i++)cmap.writeUInt32BE(old.readUInt32BE(8+i*8)+8,8+i*8);
  old.copy(cmap,header+8,header);cmap.writeUInt16BE(3,header);cmap.writeUInt16BE(10,header+2);cmap.writeUInt32BE(old.length+8,header+4);
  const at=old.length+8;cmap.writeUInt16BE(12,at);cmap.writeUInt32BE(length,at+4);cmap.writeUInt32BE(groups.length,at+12);
  groups.forEach(([code,id],i)=>{cmap.writeUInt32BE(code,at+16+i*12);cmap.writeUInt32BE(code,at+20+i*12);cmap.writeUInt32BE(id,at+24+i*12);});tables.set('cmap',cmap);
  const entries=[...tables].sort(([a],[b])=>a<b?-1:1),out=Buffer.alloc(12+entries.length*16+entries.reduce((n,[,v])=>n+((v.length+3)&~3),0));
  out.writeUInt32BE(b.readUInt32BE(0),0);out.writeUInt16BE(entries.length,4);
  const power=Math.floor(Math.log2(entries.length));out.writeUInt16BE(16*2**power,6);out.writeUInt16BE(power,8);out.writeUInt16BE(entries.length*16-16*2**power,10);
  let cursor=12+entries.length*16;
  entries.forEach(([tag,data],i)=>{out.write(tag,12+i*16);out.writeUInt32BE(cursor,20+i*16);out.writeUInt32BE(data.length,24+i*16);data.copy(out,cursor);cursor+=(data.length+3)&~3;});return out;
}

test('sparse coverage repairs kept-empty Latin and unseen Korean/non-BMP/composite glyphs through undo and reopen',async()=>{
  const probe=new Engine();probe.addFontFile(label,file(original));const han=textDoc(probe,'한');
  const glyph=JSON.parse(han.glyphRequests()).find((r:any)=>r.label===label).glyphs[0];han.free();probe.free();
  const font=emojiAlias(original,glyph),full=new Engine(),sparse=new Engine();full.addFontFile(label,file(font));
  const initial=textDoc(full,'A'),bytes=initial.serializeAs('hwpx',false);initial.free();
  const a=full.open(bytes),b=sparse.open(bytes);let subset=await compactSfntFace(font,{format:'ttf',faceIndex:0},'A');assert.ok(subset);
  sparse.addFontFile(label,file(subset));assert.equal(svg(b),svg(a));
  const offset=paras(a)[0].caret[0]+1;
  const insert=(doc:any,text:string,at=offset)=>doc.transact(JSON.stringify({ops:[{op:'insertText',at:{section:0,para:0,offset:at},text}]}));
  async function refill(){
    const requests=JSON.parse(b.glyphRequests()),included=fontGlyphCoverage(subset!);
    if(included)assert.ok(requests.some((r:any)=>r.label===label&&r.glyphs.some((g:number)=>!(included[g>>3]&(1<<(g&7))))));
    else assert.ok(JSON.parse(sparse.outlineRequests()).includes(label));
    const retained=JSON.parse(sparse.glyphCoverage(JSON.stringify([label]))).flatMap((r:any)=>r[2]);
    subset=(await compactSfntFace(font,{format:'ttf',faceIndex:0},sparse.fontCharacters(),retained))??font;sparse.addFontFile(label,file(subset));
  }
  try{
    insert(a,'Q');insert(b,'Q');b.glyphRequests();
    assert.deepEqual(JSON.parse(sparse.outlineRequests()),[label],'an omitted glyph must not be cached as legitimately empty');
    await refill();assert.equal(svg(b),svg(a));
    insert(a,'é각😀Å',offset+1);insert(b,'é각😀Å',offset+1);
    a.glyphRequests();full.addFontFile(label,file(font));
    const before=JSON.parse(b.state());await refill();const after=JSON.parse(b.state());
    for(const key of ['contentEpoch','dirty','undo','redo'])assert.equal(after[key],before[key]);
    assert.equal(svg(b),svg(a));a.undo();b.undo();assert.equal(svg(b),svg(a));a.redo();b.redo();assert.equal(svg(b),svg(a));
    for(const format of ['hwpx','hwp5']){const back=sparse.open(b.serializeAs(format,false));try{assert.equal(paras(back)[0].text,paras(b)[0].text);assert.equal(svg(back),svg(b));}finally{back.free();}}
  }finally{a.free();b.free();full.free();sparse.free();}
});

test('a composite glyph includes its components on the first paint',async()=>{
  const full=new Engine(),sparse=new Engine();full.addFontFile(label,file(original));
  const initial=textDoc(full,'é'),bytes=initial.serializeAs('hwpx',false);initial.free();const a=full.open(bytes),b=sparse.open(bytes);full.addFontFile(label,file(original));
  const subset=await compactSfntFace(original,{format:'ttf',faceIndex:0},'é');assert.ok(subset);sparse.addFontFile(label,file(subset));
  try{assert.equal(svg(b),svg(a));}finally{a.free();b.free();full.free();sparse.free();}
});
