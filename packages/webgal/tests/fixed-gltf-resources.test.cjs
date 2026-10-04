const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const test=require('node:test');
const ts=require('typescript');
const filename=path.resolve(__dirname,'../src/Core/controller/stage/pixi/fixedGltfResources.ts');
const loaded=new Module(filename,module);
loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021},
}).outputText,filename);
const {FixedGltfResources,ResourceHttpError,resolveFigureConfig}=loaded.exports;
const base='http://localhost/games/demo/';
const url=p=>new URL(`game/3d/${p}`,base).href;
function binary(metadata={}) {
  const header=Buffer.from(JSON.stringify(metadata));
  const buffer=Buffer.alloc(Math.ceil((12+header.length)/8)*8);
  buffer.write('MOTION\0\0');buffer.writeUInt32LE(header.length,8);header.copy(buffer,12);
  return new Response(buffer);
}
function fixture(files){
  const calls=[];
  const fetcher=async target=>{calls.push(target);const item=files.get(target);
    if(item===undefined)return new Response('',{status:404});
    if(item instanceof Response)return item.clone();
    return new Response(typeof item==='string'?item:JSON.stringify(item));
  };
  return {catalog:new FixedGltfResources(base,fetcher),calls,fetcher};
}
test('default browser fetch retains the global receiver during warmup and resource loading',async t=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=function(target){
    assert.equal(this,globalThis,'native Window.fetch must not receive the resource catalog as this');
    calls.push(target);
    return Promise.resolve(new Response(JSON.stringify(target.endsWith('index.json')?{packages:[]}:{value:1})));
  };
  t.after(()=>{globalThis.fetch=originalFetch;});
  const catalog=new FixedGltfResources(base);
  await catalog.load();
  assert.deepEqual(await catalog.fetch(url('figure/test/config.json')),{value:1});
  assert.equal(calls.length,2);
});

test('all runtime packages register without game-name assumptions, and source bytes are shared',async()=>{
  const {catalog,calls}=fixture(new Map([
    [url('runtime/index.json'),{packages:['third_party/config.json']}],
    [url('runtime/third_party/config.json'),{components:[{type:'shader',name:'Custom',src:'shader.glsl'}]}],
    [url('runtime/third_party/shader.glsl'),'glsl'],
  ]));
  await Promise.all([catalog.load(),catalog.load()]);
  assert.equal(catalog.entries[0].name,'Custom');
  await catalog.preload('shader','Custom');
  assert.equal(await(await catalog.response(url('runtime/third_party/shader.glsl'))).text(),'glsl');
  assert.equal(calls.filter(p=>p.endsWith('shader.glsl')).length,1);
});
test('explicit motionbin skips parameter probes; extensionless tries mtn then binary on 404',async()=>{
  const {catalog,calls}=fixture(new Map([[url('motion/nested/pose.motionbin'),binary()]]));
  const explicit=await catalog.resolveMotion('nested/pose.motionbin');
  assert.equal(explicit.type,'motion');
  assert.ok(!calls.some(p=>p.endsWith('.mtn')));
  const implicit=await catalog.resolveMotion('nested/pose');
  assert.equal(implicit.type,'motion');
  assert.ok(calls.includes(url('mtn_exp/nested/pose.mtn')));
  assert.equal(calls.filter(p=>p.endsWith('pose.motionbin')).length,1);
});
test('mtn wins when both exist; fade settings match src rather than old names',async()=>{
  const {catalog,calls}=fixture(new Map([
    [url('mtn_exp/anon/bye01.mtn'),'parameter text'],
    [url('motion/anon/bye01.motionbin'),'binary'],
    [url('mtn_exp/config.json'),{components:[{type:'garupa-motion',name:'old-name',src:'anon/bye01.mtn',fade_in:0.25,fade_out:0.75}]}],
  ]));
  const motion=await catalog.resolveMotion('anon/bye01');
  assert.equal(motion.type,'garupa-motion');assert.equal(motion.component.fade_in,0.25);
  assert.equal(motion.name,'anon/bye01');
  assert.ok(!calls.includes(url('motion/anon/bye01.motionbin')));
});
test('non-404 failures never fallback, optional only suppresses absent resources',async()=>{
  const {catalog,calls}=fixture(new Map([[url('mtn_exp/broken.mtn'),new Response('',{status:503})]]));
  await assert.rejects(catalog.resolveMotion('broken',{optional:true}),e=>e instanceof ResourceHttpError&&e.status===503);
  assert.ok(!calls.includes(url('motion/broken.motionbin')));
  assert.equal(await catalog.resolveMotion('missing',{optional:true}),null);
  assert.equal(await catalog.resolveExpression('native',{optional:true}),null);
});
test('native motion metadata is self-contained in the binary header and never requests config.json',async()=>{
  const {catalog,calls}=fixture(new Map([
    [url('motion/garupa/test.motionbin'),binary({name:'native metadata name',motionGroup:'garupa',description:'说明',type:'wrong',src:'wrong'})],
    [url('motion/config.json'),{components:[{type:'motion',name:'arbitrary',src:'garupa/test.motionbin',motionGroup:'garupa',description:'说明'}]}],
  ]));
  const motion=await catalog.resolveMotion('garupa/test.motionbin');
  assert.equal(motion.motionGroup,'garupa');assert.equal(motion.component.description,'说明');
  assert.equal(motion.name,'garupa/test.motionbin');assert.equal(motion.component.name,'native metadata name');
  assert.equal(motion.type,'motion');assert.equal(motion.component.src,'test.motionbin');
  assert.ok(!calls.some(value=>value.endsWith('/config.json')));
});
test('a malformed native binary header fails without probing another resource',async()=>{
  const {catalog,calls}=fixture(new Map([[url('motion/bad.motionbin'),'not binary']]));
  await assert.rejects(catalog.resolveMotion('bad.motionbin'),/binary motion/);
  assert.deepEqual(calls,[url('motion/bad.motionbin')]);
});
test('figure config prefers 3d, falls back to 2d only on 404 and classifies content',async t=>{
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch;});
  const {fetcher,calls}=fixture(new Map([
    [new URL('game/figure/live/config.json',base).href,{model:'live.moc'}],
    [url('figure/model/config.json'),{components:[{type:'model',role:'integrated'}]}],
    [url('figure/broken/config.json'),'{broken'],
    [new URL('game/figure/broken/config.json',base).href,{model:'should not fallback'}],
  ]));
  global.fetch=fetcher;
  const model=await resolveFigureConfig('game/figure/model/config.json',base);
  assert.equal(model.gltf,true);assert.equal(model.url,url('figure/model/config.json'));
  const live=await resolveFigureConfig('game/figure/live/config.json',base);
  assert.equal(live.gltf,false);assert.equal(live.url,new URL('game/figure/live/config.json',base).href);
  await assert.rejects(resolveFigureConfig('game/figure/broken/config.json',base),SyntaxError);
  assert.ok(!calls.includes(new URL('game/figure/broken/config.json',base).href));
});
