const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function load(OffscreenCharacter = {}, resolveFigure = async url=>({url:new URL(url,document.baseURI).href,gltf:true}), meshClothEnabled = false) {
  const filename=path.resolve(__dirname,'../src/Core/controller/stage/pixi/gltfCharacter.ts');
  const loaded=new Module(filename,module);
  loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  const catalog={indexUrl:'http://localhost/game/3d/runtime/index.json',load:async()=>catalog};
  loaded.require=name=>name==='@/store/store'?{webgalStore:{getState:()=>({userData:{optionData:{meshClothEnabled}}})}}:name==='webgal-lovelive-gltf-renderer'?{OffscreenCharacter}:name==='./fixedGltfResources'
    ?{fixedGltfResources:()=>catalog,resolveFigureConfig:resolveFigure}
    :Module.prototype.require.call(loaded,name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,filename);
  return loaded.exports;
}
function deferred() { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setGlobal(t,key,value) { const old=Object.getOwnPropertyDescriptor(global,key); Object.defineProperty(global,key,{value,writable:true,configurable:true}); t.after(()=>{if(old)Object.defineProperty(global,key,old);else delete global[key];}); }
const request=id=>({url:'game/a/config.json',motion:'motion',expression:'face',preloadId:id});

test('progress lookahead only fetches glTF inputs and never allocates speculative contexts', async t=>{
  setGlobal(t,'document',{baseURI:'http://localhost/'});
  const calls=[];
  const api=load({preloadNamed:async(index,requests)=>calls.push(requests),
    setPreloadRequests(){throw Error('unexpected GPU allocation');}},
    async url=>({url,gltf:!url.includes('live')}));
  await api.setGltfPreloadRequests([{...request('live'),url:'game/live/config.json'}],100,100);
  assert.deepEqual(calls,[]);
  await api.setGltfPreloadRequests([request('next')],100,100);
  assert.deepEqual(calls,[[{kind:'motion',name:'motion'},{kind:'expression',name:'face'}]]);
});

test('preload and direct display disable mesh cloth while preserving bone physics', async t=>{
  setGlobal(t,'document',{baseURI:'http://localhost/'});
  const options=[];
  const api=load({preload(o){options.push(o);},
    takePreloaded(o){options.push(o);return null;},create(o){options.push(o);return {};}});
  await api.preloadGltfCharacter('game/a/config.json',1920,1440);
  await api.createGltfCharacter('game/a/config.json',1920,1440);
  assert.equal(options.length,3);
  for(const o of options){assert.equal(o.meshClothEnabled,false);assert.notEqual(o.physicsEnabled,false);}
});

test('prepared initial command names are not replayed; prepare waits for late commands', async()=>{
  const first=deferred();const calls=[];let preparations=0;
  const {GltfCharacterRuntime}=load();
  const runtime=new GltfCharacterRuntime({setMotion:async name=>calls.push(['motion',name]),
    setExpression:async name=>calls.push(['expression',name]),prepare:async()=>{
      preparations++;if(preparations===1)await first.promise;
    }},{motion:'initial',expression:'face'});
  runtime.setMotion('initial');runtime.setExpression('face');
  const preparing=runtime.prepare();await flush();
  runtime.setExpression('late');first.resolve();await preparing;
  assert.deepEqual(calls,[['expression','late']]);assert.equal(preparations,2);
});

test('failed same-name commands can retry, and superseded failures do not poison the latest state', async t=>{
  t.mock.method(console,'error',()=>{});
  const {GltfCharacterRuntime}=load();let attempts=0;
  const runtime=new GltfCharacterRuntime({setMotion:async()=>{if(++attempts===1)throw Error('once');},prepare:async()=>{}});
  runtime.setMotion('m');await assert.rejects(runtime.prepare(),/once/);
  runtime.setMotion('m');await runtime.prepare();assert.equal(attempts,2);
  const other=new GltfCharacterRuntime({setMotion:async name=>{if(name==='old')throw Error('old');},prepare:async()=>{}});
  other.setMotion('old');other.setMotion('new');await other.prepare();
});

test('dispose during pending commands prevents GPU preparation and future queued work', async()=>{
  const pending=deferred();const {GltfCharacterRuntime}=load();let prepares=0,expressions=0,disposals=0;
  const runtime=new GltfCharacterRuntime({setMotion:()=>pending.promise,setExpression:async()=>{expressions++;},
    prepare:async()=>{prepares++;},dispose(){disposals++;}});
  runtime.setMotion('m');runtime.setExpression('e');const preparing=runtime.prepare();await flush();
  runtime.dispose();runtime.dispose();pending.resolve();await preparing;
  assert.equal(disposals,1);assert.equal(prepares,0);assert.equal(expressions,0);
});

test('runtime update forwards the original delta and disposal stops future updates',()=>{
  const {GltfCharacterRuntime}=load(),calls=[];
  const runtime=new GltfCharacterRuntime({update:delta=>calls.push(['update',delta]),
    dispose:()=>calls.push(['dispose'])});
  runtime.update(.25);runtime.update(.05);
  assert.deepEqual(calls,[['update',.25],['update',.05]]);
  runtime.dispose();runtime.update(.5);runtime.dispose();
  assert.deepEqual(calls,[['update',.25],['update',.05],['dispose']]);
});


test('experimental mesh cloth setting reaches direct and preloaded actors without disabling bone physics', async t=>{
  setGlobal(t,'document',{baseURI:'http://localhost/'});
  const options=[];
  const api=load({preload:o=>options.push(o),takePreloaded:o=>{options.push(o);return null;},create:o=>{options.push(o);return {}; }},async url=>({url,gltf:true}),true);
  await api.preloadGltfCharacter('game/a/config.json',1920,1080);
  await api.createGltfCharacter('game/a/config.json',1920,1080);
  for(const o of options){assert.equal(o.meshClothEnabled,true);assert.notEqual(o.physicsEnabled,false);}
});
