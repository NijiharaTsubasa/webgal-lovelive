const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const test=require('node:test');
const ts=require('typescript');
const filename=path.resolve(__dirname,'../src/Core/controller/stage/pixi/syncPixiStageState.ts');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  const figures=new Map(),requests=[],calls=[];
  let state={bgName:'',figName:'',freeFigure:[],live2dMotion:[],live2dExpression:[],live2dBlink:[],live2dFocus:[],figureMetaData:{},effects:[]};
  const stage={getStageObjByKey:key=>figures.get(key),getFigureObjects:()=>[...figures.values()],
    getAllStageObj:()=>[],getAllLockedObject:()=>[],requestRender(){},removeAnimation(){},
    removeStageObjectByKey:key=>figures.delete(key),
    addGltfFigure(key,url){calls.push(['3d',key,url]);figures.set(key,{key,sourceUrl:url});},
    addLive2dFigure(key,url){calls.push(['2d',key,url]);figures.set(key,{key,sourceUrl:url});}};
  const globals={gameplay:{pixiStage:stage,skipAnimation:true}};
  const loaded=new Module(filename,module);
  loaded.require=name=>({
    '@/Core/Modules/stage/stageInterface':{FIGURE_KEYS:['fig-center'],FIGURE_POSITIONS:['center'],figureStateKeyByPosition:{center:'figName'},normalizeFigureBounds:()=>null},
    '@/Core/WebGAL':{WebGAL:globals},
    '@/Core/util/logger':{logger:{debug(){},error(){}}},
    '@/Core/Modules/stage/stageStateManager':{stageStateManager:{getViewStageState:()=>state}},
    '@/Core/Modules/gltf/gltfCharacter':{isGltfCharacterUrl:url=>url.endsWith('/config.json')},
    '@/Core/Modules/gltf/gltfSceneResidency':{hasPreparedGltfCharacter:()=>false},
    '@/Core/Modules/gltf/fixedGltfResources':{resolveFigureConfig:url=>new Promise(resolve=>requests.push({url,resolve}))},
  }[name]??{});
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText,filename);
  return {requests,calls,figures,update(next){state={...state,...next};loaded.exports.syncPixiStageState(state,{syncPixiStage:true,skipAnimation:true});}};
}
test('a config.json Live2D source is selected by content, not filename',async t=>{
  const previous=global.window;global.window={location:{origin:'http://localhost'}};t.after(()=>{global.window=previous;});
  const f=setup();f.update({figName:'game/figure/live/config.json'});
  f.requests[0].resolve({gltf:false,url:'http://localhost/game/figure/live/config.json'});await flush();
  assert.deepEqual(f.calls,[['2d','fig-center','http://localhost/game/figure/live/config.json']]);
  f.update({figName:'game/figure/live/config.json'});assert.equal(f.requests.length,1);
});
test('late configuration resolution cannot resurrect a replaced or removed figure',async()=>{
  const f=setup();f.update({figName:'game/figure/a/config.json'});f.update({figName:'game/figure/b/config.json'});
  f.requests[0].resolve({gltf:true,url:'http://localhost/game/3d/figure/a/config.json'});await flush();assert.equal(f.calls.length,0);
  f.requests[1].resolve({gltf:true,url:'http://localhost/game/3d/figure/b/config.json'});await flush();assert.equal(f.calls[0][2],'http://localhost/game/3d/figure/b/config.json');
  f.update({freeFigure:[{key:'extra',name:'game/figure/extra/config.json',basePosition:'center'}]});
  f.update({freeFigure:[]});f.requests[2].resolve({gltf:true,url:'http://localhost/game/3d/figure/extra/config.json'});await flush();
  assert.equal(f.calls.length,1);
});
