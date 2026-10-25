const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const test=require('node:test');
const ts=require('typescript');
const filename=path.resolve(__dirname,'../src/Core/Modules/gltf/fixedGltfResources.ts');
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

test('figure packages select one integrated model or exactly one head and body',async()=>{
  const config=url('figure/character/config.json');
  for(const roles of [['integrated'],['head','body'],['body','head']]) {
    const components=roles.map(role=>({type:'model',name:role,role,group:'garupa',model:`${role}.glb`}));
    const {catalog}=fixture(new Map([[config,{components}]]));
    assert.deepEqual((await catalog.models(config)).map(e=>e.component.role),roles.includes('body')?['head','body']:roles);
    assert.ok((await catalog.models(config)).every(e=>e.group==='garupa'));
    assert.equal((await catalog.model(config)).component.role,roles.includes('body')?'body':'integrated');
  }
  for(const roles of [[],['head'],['body'],['head','head'],['body','body'],['head','body','body'],
    ['head','head','body'],['integrated','head','body'],['integrated','integrated'],['other']]) {
    const {catalog}=fixture(new Map([[config,{components:roles.map(role=>({type:'model',name:role,role}))}]]));
    await assert.rejects(catalog.models(config),roles.filter(r=>r==='head').length>1||roles.filter(r=>r==='body').length>1
      ?/多个头部或多个身体/:/需要一个完整模型/);
  }
});

test('composed paths select the head and body from their own packages and retain independent dependency bases',async()=>{
  const headConfig=url('figure/first/config.json'),bodyConfig=url('figure/second/config.json');
  const component=(role,name)=>({type:'model',role,name,model:`${role}.glb`,group:'garupa'});
  const head=component('head','head'),body=component('body','body');
  const {catalog,calls}=fixture(new Map([
    [headConfig,{components:[head,component('body','unused-body')]}],
    [bodyConfig,{components:[component('head','unused-head'),body]}],
  ]));
  const entries=await catalog.models(`${headConfig}+${bodyConfig}`);
  assert.deepEqual(entries.map(e=>[e.component.role,e.name,e.config]),[['head','head',headConfig],['body','body',bodyConfig]]);
  assert.equal(new URL(entries[0].component.model,entries[0].basePath).href,url('figure/first/head.glb'));
  assert.equal(new URL(entries[1].component.model,entries[1].basePath).href,url('figure/second/body.glb'));
  assert.equal((await catalog.model(`${headConfig}+${bodyConfig}`)).name,'body');
  assert.deepEqual(calls,[headConfig,bodyConfig]);
});

test('composed paths reject missing roles, duplicates and malformed pairs',async()=>{
  const a=url('figure/first/config.json'),b=url('figure/second/config.json');
  const model=role=>({type:'model',role,group:'garupa'});
  for (const [first,second,expected] of [
    [['body'],['body'],/第一份配置必须包含一个头部/],
    [['head'],['head'],/第二份配置必须包含一个身体/],
    [['head','head'],['body'],/多个头部或多个身体/],
    [['head'],['body','body'],/多个头部或多个身体/],
    [['head','body','body'],['body'],/多个头部或多个身体/],
  ]) {
    const {catalog}=fixture(new Map([[a,{components:first.map(model)}],[b,{components:second.map(model)}]]));
    await assert.rejects(catalog.models(`${a}+${b}`),expected);
  }
  const {catalog,calls}=fixture(new Map());
  for(const value of [`${a}+`,`${a}+${b}+${a}`,`${a}+bad.glb`])
    await assert.rejects(catalog.models(value),/必须指定两个 config.json/);
  assert.deepEqual(calls,[]);
});

test('figure resolution expands each composed path from the resource root without requesting the joined filename',async t=>{
  const originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch;});
  const localBase='http://localhost/games/composed/';
  const at=p=>new URL(`game/3d/figure/${p}/config.json`,localBase).href;
  const {fetcher,calls}=fixture(new Map([
    [at('头'),{components:[{type:'model',role:'head'}]}],
    [at('body'),{components:[{type:'model',role:'body'}]}],
  ]));
  global.fetch=fetcher;
  const resolved=await resolveFigureConfig('./game/figure/头/config.json+body/config.json',localBase);
  assert.equal(resolved.gltf,true);assert.equal(resolved.url,`${at('头')}+${at('body')}`);
  assert.deepEqual(calls,[at('头'),at('body')]);
  assert.equal((await resolveFigureConfig(resolved.url,localBase)).url,resolved.url,'canonical path remains stable during restore');
});

test('model dependency preparation does not request the default motion', async () => {
  const json = Buffer.from(JSON.stringify({ materials: [] }));
  const glb = Buffer.alloc(20 + json.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(json.length, 12);
  json.copy(glb, 20);
  const { catalog, calls } = fixture(new Map([[url('figure/a/model.glb'), new Response(glb)]]));
  await catalog.preloadModelDependencies({ config: url('figure/a/config.json'), name: 'a',
    component: { model: 'model.glb', defaultMotion: 'missing.motionbin' } });
  assert.deepEqual(calls, [url('figure/a/model.glb')]);
});
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
test('mtn wins when both exist and uses default fades without config requests',async()=>{
  const {catalog,calls}=fixture(new Map([
    [url('mtn_exp/anon/bye01.mtn'),'parameter text'],
    [url('motion/anon/bye01.motionbin'),'binary'],
    [url('mtn_exp/config.json'),{components:[{type:'garupa-motion',name:'old-name',src:'anon/bye01.mtn',fade_in:0.25,fade_out:0.75}]}],
  ]));
  const motion=await catalog.resolveMotion('anon/bye01');
  assert.equal(motion.type,'garupa-motion');assert.equal(motion.component.fade_in,500);
  assert.equal(motion.component.fade_out,500);
  assert.equal(motion.name,'anon/bye01');
  assert.ok(!calls.includes(url('motion/anon/bye01.motionbin')));
  assert.ok(!calls.some(value=>value.endsWith('/config.json')));
});
test('parameter expressions load directly without overriding file fades',async()=>{
  const {catalog,calls}=fixture(new Map([[url('mtn_exp/anon/sad.exp.json'),{params:[],fade_in:120}]]));
  const expression=await catalog.resolveExpression('anon/sad');
  assert.equal(expression.component.fade_in,undefined);
  assert.deepEqual(calls,[url('mtn_exp/anon/sad.exp.json')]);
});

test('prepared named resources and parsed configs reuse cached results',async()=>{
  const config=url('figure/a/config.json');
  const files=new Map([[config,{components:[]}],
    [url('motion/pose.motionbin'),binary({description:'pose'})]]);
  const {catalog,calls}=fixture(files);
  assert.equal(await catalog.fetch(config),await catalog.fetch(config));
  const first=await catalog.resolveMotion('pose');
  assert.equal(await catalog.resolveMotion('pose'),first);
  assert.equal(catalog.isNamedReady('motion','pose'),true);
  assert.equal(calls.filter(p=>p.endsWith('pose.mtn')).length,1);
  for(let i=0;i<256;i++) {
    const target=`http://localhost/cache/${i}`;files.set(target,'cache');await catalog.fetch(target,'bytes');
  }
  assert.equal(catalog.isNamedReady('motion','pose'),false);
});

test('missing and failed named resources can retry after becoming available',async()=>{
  const files=new Map(),{catalog}=fixture(files);
  assert.equal(await catalog.resolveExpression('later',{optional:true}),null);
  assert.equal(catalog.isNamedReady('expression','later'),false);
  files.set(url('mtn_exp/later.exp.json'),{params:[]});
  assert.ok(await catalog.resolveExpression('later'));
  files.set(url('mtn_exp/retry.mtn'),new Response('',{status:503}));
  await assert.rejects(catalog.resolveMotion('retry'));
  files.set(url('mtn_exp/retry.mtn'),'motion');
  assert.ok(await catalog.resolveMotion('retry'));
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
