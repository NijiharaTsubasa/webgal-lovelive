const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function fixture() {
  const root=path.resolve(__dirname,'../src'),cache=new Map(),jobs=[],commits=[],calls=[];
  let manager;
  const backlog=[];
  const WebGAL={sceneManager:manager,gameplay:{isFastPreview:false,performController:{
    beginCollectingPerforms(){},endCollectingPerforms(){},commitPendingPerforms(){}}},
    backlogManager:{getBacklog:()=>backlog},flowchartManager:{waitForCurrentSceneDialog(){}},};
  let state={name:'old',PerformList:[]};
  const stage={getCalculationStageState:()=>state,replaceCalculationStageState:value=>{state=value;},
    removeAllPerform(){},applyCommittedPixiEffects(){},commit(){
      commits.push({url:manager.sceneData.currentScene.sceneUrl,line:manager.sceneData.currentSentenceId,
        name:state.name,locked:manager.lockSceneWrite});
    }};
  const mocks={
    'Core/WebGAL.ts':{WebGAL},
    'Core/Modules/stage/stageStateManager.ts':{stageStateManager:stage},
    'Core/controller/scene/sceneFetcher.ts':{sceneFetcher:url=>new Promise((resolve,reject)=>jobs.push({url,resolve,reject}))},
    'Core/parser/sceneParser.ts':{sceneParser:(raw,name,url)=>({sceneUrl:url,sceneName:name,sentenceList:[]})},
    'Core/util/logger.ts':{logger:{debug(){},info(){},error(){calls.push('error');}}},
    'store/store.ts':{webgalStore:{dispatch(){},getState(){return {};}}},
    'store/GUIReducer.ts':{setVisibility:value=>value},
    'Core/controller/gamePlay/stopAllPerform.ts':{stopAllPerform(){calls.push('stop');}},
    'Core/controller/gamePlay/runScript.ts':{runScript(){}},
    'Core/gameScripts/changeBg/setEbg.ts':{setEbg(){}},
    'Core/gameScripts/setVar.ts':{setGameVar(value){calls.push(['var',value]);}},
    'Core/controller/gamePlay/nextSentence.ts':{continueSentence(){calls.push('continue');},cancelPendingForward(){ const api=load('Core/util/sceneCharacterLoading.ts'); api.cancelCharacterLoading(); }},
    'Core/util/prefetcher/assetsPrefetcher.ts':{clearPrefetchLinks(){}},
  };
  function load(relative) {
    relative=relative.replaceAll('\\','/');
    if(mocks[relative])return mocks[relative];
    if(cache.has(relative))return cache.get(relative).exports;
    const filename=path.join(root,relative),loaded=new Module(filename,module);cache.set(relative,loaded);
    loaded.paths=Module._nodeModulePaths(path.dirname(filename));
    loaded.require=name=>{
      if(name.startsWith('@/')||name.startsWith('.')) {
        const file=name.startsWith('@/')?name.slice(2):path.relative(root,path.resolve(path.dirname(filename),name));
        return load(file.endsWith('.ts')?file:`${file}.ts`);
      }
      return Module.prototype.require.call(loaded,name);
    };
    loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{
      module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true,
    }}).outputText,filename);
    return loaded.exports;
  }
  manager=new (load('Core/Modules/scene.ts').SceneManager)();
  manager.sceneData.currentScene={sceneUrl:'old.txt',sceneName:'old',sentenceList:[]};
  manager.sceneData.currentSentenceId=1;
  WebGAL.sceneManager=manager;
  const pop=manager.popFrame.bind(manager);
  manager.popFrame=()=>{calls.push('pop');return pop();};
  const save=(url,line=7)=>({sceneData:{sceneUrl:url,sceneName:url,currentSentenceId:line,sceneStack:[],currentLocals:{marker:url}},
    nowStageState:{name:url,PerformList:[],bgName:''},backlog:[]});
  return {load,manager,jobs,commits,calls,backlog,save,WebGAL};
}

test('editor fast preview crosses a called scene and returns without preparing intermediate models',async()=>{
  const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts'),prepared=[];
  loading.setCharacterLoadingMode('scene');
  loading.registerSceneCharacterLoadingHooks({
    prepareScene:async scene=>prepared.push(['scene',scene.sceneUrl]),
    prepareStage:async stage=>prepared.push(['stage',stage.name]),
  });
  f.WebGAL.gameplay.isFastPreview=true;
  f.manager.sceneData.currentSentenceId=4;
  const child=f.load('Core/controller/scene/callScene.ts').callScene('child.txt','child');
  f.jobs[0].resolve('child');await child;
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'child.txt');
  assert.equal(f.manager.sceneData.sceneStack.length,1);
  const parent=f.load('Core/controller/scene/returnFromScene.ts').returnFromScene();
  f.jobs[1].resolve('parent');await parent;
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');
  assert.equal(f.manager.sceneData.currentSentenceId,5);
  assert.equal(f.manager.sceneData.sceneStack.length,0);
  assert.deepEqual(prepared,[]);
  assert.equal(f.calls.includes('continue'),false);
  assert.equal(loading.getCharacterLoadingStatus().phase,'idle');
  f.WebGAL.gameplay.isFastPreview=false;
  await loading.prepareStageCharacters({name:'target'},new AbortController().signal);
  assert.deepEqual(prepared,[['stage','target']]);
  const normal=f.load('Core/controller/scene/changeScene.ts').changeScene('normal.txt','normal');
  f.jobs[2].resolve('normal');await normal;
  assert.deepEqual(prepared,[['stage','target'],['scene','normal.txt']]);
  assert.equal(f.calls.includes('continue'),true);
});

test('cross-scene load commits only after scene identity and saved cursor are restored',async()=>{
  const f=fixture(),{loadGameFromStageData}=f.load('Core/controller/storage/loadGame.ts');
  const pending=loadGameFromStageData(f.save('saved.txt',12));
  assert.equal(f.manager.lockSceneWrite,true);assert.deepEqual(f.commits,[]);assert.equal(f.manager.sceneData.currentSentenceId,1);
  f.jobs[0].resolve('scene');await pending;
  assert.deepEqual(f.commits,[{url:'saved.txt',line:12,name:'saved.txt',locked:false}]);
  assert.equal(f.manager.sceneWritePromise,null);
});

test('reset during an in-flight write unlocks a new scene and rejects the old response',async()=>{
  const f=fixture(),{changeScene}=f.load('Core/controller/scene/changeScene.ts');
  changeScene('stale.txt','stale');const old=f.manager.sceneWritePromise;
  f.manager.resetScene();assert.equal(f.manager.lockSceneWrite,false);
  changeScene('new.txt','new');const latest=f.manager.sceneWritePromise;
  assert.equal(f.jobs.length,2);assert.notEqual(latest,old);
  f.jobs[0].resolve('old');await old;assert.equal(f.manager.lockSceneWrite,true);
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'');
  f.jobs[1].resolve('new');await latest;
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'new.txt');assert.equal(f.manager.lockSceneWrite,false);
});

test('a cancelled call followed by failed restore keeps the original locals and call stack',async()=>{
  const f=fixture();f.manager.sceneData.currentLocals={parent:1};
  f.load('Core/controller/scene/callScene.ts').callScene('child.txt','child',{child:2});
  const old=f.manager.sceneWritePromise;
  assert.deepEqual(f.manager.sceneData.currentLocals,{parent:1});assert.equal(f.manager.sceneData.sceneStack.length,0);
  const latest=f.load('Core/controller/storage/loadGame.ts').loadGameFromStageData(f.save('missing.txt'));
  f.jobs[1].reject(Error('503'));await latest;f.jobs[0].resolve('child');await old;
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');
  assert.deepEqual(f.manager.sceneData.currentLocals,{parent:1});assert.equal(f.manager.sceneData.sceneStack.length,0);
});

test('successful call records its invocation line even when forward has already advanced the cursor',async()=>{
  const f=fixture();f.manager.sceneData.currentSentenceId=4;f.manager.sceneData.currentLocals={parent:1};
  f.load('Core/controller/scene/callScene.ts').callScene('child.txt','child',{child:2},'result');
  const pending=f.manager.sceneWritePromise;f.manager.sceneData.currentSentenceId=5;
  f.jobs[0].resolve('child');await pending;
  assert.deepEqual(f.manager.sceneData.currentLocals,{child:2});
  assert.deepEqual(f.manager.sceneData.sceneStack,[{sceneName:'old',sceneUrl:'old.txt',continueLine:4,locals:{parent:1},writeReturnTo:'result'}]);
  const entry=f.manager.popFrame();assert.equal(entry.continueLine,4);assert.deepEqual(f.manager.sceneData.currentLocals,{parent:1});
});

test('newest restore owns scene, stage and lock when older responses arrive out of order',async()=>{
  const f=fixture(),{loadGameFromStageData}=f.load('Core/controller/storage/loadGame.ts');
  const old=loadGameFromStageData(f.save('older.txt'));
  const latest=loadGameFromStageData(f.save('newer.txt'));
  f.jobs[0].resolve('old');await old;
  assert.equal(f.manager.lockSceneWrite,true);assert.equal(f.manager.sceneWritePromise,latest);assert.deepEqual(f.commits,[]);
  f.jobs[1].resolve('new');await latest;
  assert.deepEqual(f.commits.map(item=>item.url),['newer.txt']);
});

test('failed scene restore leaves stage intact and permits a later retry',async()=>{
  const f=fixture(),{loadGameFromStageData}=f.load('Core/controller/storage/loadGame.ts');
  const failed=loadGameFromStageData(f.save('saved.txt'));f.jobs[0].reject(Error('503'));await failed;
  assert.equal(f.manager.lockSceneWrite,false);assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');assert.deepEqual(f.commits,[]);
  const retry=loadGameFromStageData(f.save('saved.txt'));f.jobs[1].resolve('scene');await retry;
  assert.equal(f.commits.length,1);
});

test('an old restore finishing after the newest commit cannot replace the new stage',async()=>{
  const f=fixture(),{loadGameFromStageData}=f.load('Core/controller/storage/loadGame.ts');
  const old=loadGameFromStageData(f.save('older.txt'));
  const latest=loadGameFromStageData(f.save('newer.txt'));
  f.jobs[1].resolve('new');await latest;f.jobs[0].resolve('old');await old;
  assert.deepEqual(f.commits.map(item=>item.url),['newer.txt']);
  assert.equal(f.manager.sceneData.currentScene.sceneUrl,'newer.txt');
});

test('a failed superseded callScene cannot pop the restored call stack or unlock the new request',async()=>{
  const f=fixture();f.load('Core/controller/scene/callScene.ts').callScene('stale.txt','stale');
  const old=f.manager.sceneWritePromise;
  const latest=f.load('Core/controller/storage/loadGame.ts').loadGameFromStageData(f.save('newer.txt'));
  f.jobs[0].reject(Error('stale failure'));await old;
  assert.equal(f.calls.includes('pop'),false);assert.equal(f.manager.lockSceneWrite,true);
  f.jobs[1].resolve('new');await latest;
});

test('backlog refetch uses the same atomic restore; no-refetch also prepares before publishing',async()=>{
  const f=fixture(),{jumpFromBacklog}=f.load('Core/controller/storage/jumpFromBacklog.ts');
  const saved=f.save('backlog.txt',21);f.backlog.push({saveScene:saved.sceneData,currentStageState:saved.nowStageState});
  const pending=jumpFromBacklog(0);assert.deepEqual(f.commits,[]);f.jobs[0].resolve('scene');await pending;
  assert.deepEqual(f.commits,[{url:'backlog.txt',line:21,name:'backlog.txt',locked:false}]);
  await jumpFromBacklog(0,false);assert.equal(f.commits.length,2);assert.equal(f.jobs.length,1);
});

for (const method of ['changeScene','callScene','restoreScene']) {
  test(`a superseded ${method} cannot overwrite a load, pop its stack, unlock it or continue playback`,async()=>{
    const f=fixture(),api=f.load(`Core/controller/scene/${method}.ts`);
    const args=method==='restoreScene'?[{sceneUrl:'stale.txt',sceneName:'stale',continueLine:0}]:['stale.txt','stale'];
    api[method](...args);const old=f.manager.sceneWritePromise;
    const {loadGameFromStageData}=f.load('Core/controller/storage/loadGame.ts');
    const latest=loadGameFromStageData(f.save('latest.txt'));
    f.jobs[0].resolve('stale');await old;
    assert.equal(f.manager.lockSceneWrite,true);assert.equal(f.manager.sceneWritePromise,latest);
    assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');assert.equal(f.calls.includes('continue'),false);
    f.jobs[1].resolve('latest');await latest;assert.equal(f.manager.sceneData.currentScene.sceneUrl,'latest.txt');
  });
}

function deferred() { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; }
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('saved scene and complete stage remain unpublished while character preparation waits',async()=>{
  const f=fixture(), scene=deferred(), stage=deferred(),seen=[];
  const loading=f.load('Core/util/sceneCharacterLoading.ts');
  loading.registerSceneCharacterLoadingHooks({prepareScene:async(s,state)=>{seen.push(['scene',s.sceneUrl,state.name]);await scene.promise;},
    prepareStage:async state=>{seen.push(['stage',state.name]);await stage.promise;}});
  const p=f.load('Core/controller/storage/loadGame.ts').loadGameFromStageData(f.save('saved.txt',18));
  f.jobs[0].resolve('scene');await tick();assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');assert.deepEqual(f.commits,[]);
  scene.resolve();await tick();assert.deepEqual(seen,[['scene','saved.txt','saved.txt'],['stage','saved.txt']]);
  assert.deepEqual(f.commits,[]);stage.resolve();await p;assert.equal(f.commits.length,1);
  assert.equal(loading.getCharacterLoadingStatus().phase,'idle');
});
test('UI cancellation immediately unlocks a scene preparation and rejects its late completion',async()=>{
  const f=fixture(),wait=deferred(),loading=f.load('Core/util/sceneCharacterLoading.ts');
  loading.registerSceneCharacterLoadingHooks({prepareScene:()=>wait.promise,prepareStage:async()=>{}});
  const p=f.load('Core/controller/scene/changeScene.ts').changeScene('new.txt','new');
  f.jobs[0].resolve('scene');await tick();loading.cancelCharacterLoading();
  assert.equal(f.manager.lockSceneWrite,false);assert.equal(f.manager.sceneWritePromise,null);
  wait.resolve();await p;assert.equal(f.manager.sceneData.currentScene.sceneUrl,'old.txt');assert.equal(f.calls.includes('continue'),false);
});
test('failed stage restoration can retry preparation without publishing the failed stage',async()=>{
  const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts');let attempt=0;
  loading.registerSceneCharacterLoadingHooks({prepareScene:async()=>{},prepareStage:async()=>{if(++attempt===1)throw Error('shader');}});
  const p=f.load('Core/controller/storage/loadGame.ts').loadGameFromStageData(f.save('saved.txt'));
  f.jobs[0].resolve('scene');await p;assert.deepEqual(f.commits,[]);assert.equal(loading.getCharacterLoadingStatus().phase,'error');
  const retry=loading.retryCharacterLoading();f.jobs[1].resolve('scene');await retry;
  assert.equal(attempt,2);assert.equal(f.commits.length,1);
});
test('on-demand scene mode skips scene-wide preparation but still waits for restored stage',async()=>{
  const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts'),calls=[];
  loading.setCharacterLoadingMode('on-demand');
  loading.registerSceneCharacterLoadingHooks({prepareScene:async()=>calls.push('scene'),prepareStage:async()=>calls.push('stage')});
  const p=f.load('Core/controller/storage/loadGame.ts').loadGameFromStageData(f.save('saved.txt'));
  f.jobs[0].resolve('scene');await p;assert.deepEqual(calls,['stage']);
});

test('cancelled scene command restores its invocation cursor rather than skipping the transition',async()=>{
 const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts');
 f.manager.sceneData.currentSentenceId=4;
 const p=f.load('Core/controller/scene/changeScene.ts').changeScene('next.txt','next');
 f.manager.sceneData.currentSentenceId=5;loading.cancelCharacterLoading();
 assert.equal(f.manager.sceneData.currentSentenceId,4);assert.equal(f.manager.lockSceneWrite,false);
 f.jobs[0].resolve('scene');await p;assert.equal(f.manager.sceneData.currentSentenceId,4);
});

test('return keeps the call frame and locals until preparation succeeds, including failure and retry',async()=>{
 const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts');
 f.manager.sceneData.currentLocals={child:1};f.manager.sceneData.sceneStack=[{sceneUrl:'parent.txt',sceneName:'parent',continueLine:3,locals:{parent:2},writeReturnTo:'result'}];
 const p=f.load('Core/controller/scene/returnFromScene.ts').returnFromScene(7);
 assert.equal(f.manager.sceneData.sceneStack.length,1);assert.deepEqual(f.manager.sceneData.currentLocals,{child:1});
 f.jobs[0].reject(Error('503'));await p;assert.equal(f.manager.sceneData.sceneStack.length,1);assert.equal(f.calls.includes('pop'),false);
 const retry=loading.retryCharacterLoading();f.jobs[1].resolve('parent');await retry;
 assert.equal(f.manager.sceneData.sceneStack.length,0);assert.deepEqual(f.manager.sceneData.currentLocals,{parent:2});
 assert.deepEqual(f.calls.find(x=>Array.isArray(x)),['var',{key:'result',value:7}]);assert.equal(f.manager.sceneData.currentSentenceId,4);
});
