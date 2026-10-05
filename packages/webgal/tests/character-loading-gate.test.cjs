const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};}
function fixture(){
 const root=path.resolve(__dirname,'../src'),cache=new Map(),calls=[];let stage={roles:[],text:'old'};
 const WebGAL={sceneManager:{sceneData:{currentScene:{sceneUrl:'a'},currentSentenceId:0},lockSceneWrite:false},events:{userInteractNext:{emit(){calls.push('click');}}},
 gameplay:{performController:{hasBlockingNextPerform:()=>false,hasUnsettledNonHoldPerform:()=>false,discardUncommittedNonHoldPerforms(){},clearNonHoldPerformsFromStageState(){},beginCollectingPerforms(){},endCollectingPerforms(){},commitPendingPerforms(){calls.push('performs');}}},flowchartManager:{unlockPendingCurrentScene(){}}};
 const state={getCalculationStageState:()=>stage,replaceCalculationStageState:s=>stage=s,commit(){calls.push(['commit',stage.text,stage.roles.length]);},applyCommittedPixiEffects(){}};
 const mocks={'UI/BottomControlPanel/bottomControlPanel.module.scss.ts':{default:{}},'Core/WebGAL.ts':{WebGAL},'Core/Modules/stage/stageStateManager.ts':{stageStateManager:state},'Core/util/logger.ts':{logger:{error(){},warn(){},debug(){}}},
 'store/store.ts':{webgalStore:{getState:()=>({GUI:{showTitle:false},userData:{optionData:{autoSpeed:100}}})}},'Core/controller/gamePlay/scriptExecutor.ts':{scriptExecutor(){calls.push('forward');stage={text:'new',roles:['a','b']};WebGAL.sceneManager.sceneData.currentSentenceId++;}}};
 function load(rel){if(mocks[rel])return mocks[rel];if(cache.has(rel))return cache.get(rel).exports;
 const filename=path.join(root,rel),m=new Module(filename,module);cache.set(rel,m);m.paths=Module._nodeModulePaths(path.dirname(filename));
 m.require=name=>{if(name.startsWith('@/')||name.startsWith('.')){let file=name.startsWith('@/')?name.slice(2):path.relative(root,path.resolve(path.dirname(filename),name)).replaceAll('\\','/');return load(file.endsWith('.ts')?file:file+'.ts');}return Module.prototype.require.call(m,name);};
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);return m.exports;}
 return {load,calls,WebGAL,state,mocks};
}

for (const kind of ['scene','stage']) test(`background -next completion cannot publish Anon or dialogue during ${kind} loading`,()=>{
 const f=fixture();delete f.mocks['Core/Modules/stage/stageStateManager.ts'];
 f.mocks['Core/live2DCore.ts']={baseBlinkParam:{},baseFocusParam:{}};
 const {stageStateManager:stage}=f.load('Core/Modules/stage/stageStateManager.ts');
 const loading=f.load('Core/util/sceneCharacterLoading.ts');
 const {PerformController}=f.load('Core/Modules/perform/performController.ts');
 const controller=new PerformController(),shown=[];
 stage.setStage('figName','old.png');stage.commit();
 stage.setCommitHandler(state=>shown.push([state.figNameLeft,state.figNameRight,state.showText]));
 stage.setStage('figNameLeft','3d/new/config.json');
 stage.setStage('figNameRight','live2d/new/model.json');
 stage.setStage('showText','Hello World!');
 const perform={performName:'animation-bg-main',isStarted:true,stopFunction(){},blockingNext:()=>false};
 controller.performList.push(perform);
 stage.addPerform({id:perform.performName,isHoldOn:false,script:{}});
 const ticket=loading.beginCharacterLoading(kind);
 controller.softUnmountPerformObject(perform);
 assert.deepEqual(shown,[],'no queued character may reach Pixi before group preparation completes');
 assert.equal(stage.getViewStageState().figNameRight,'');
 assert.equal(stage.getViewStageState().showText,'');
 ticket.succeed();stage.commit();
 assert.deepEqual(shown,[['3d/new/config.json','live2d/new/model.json','Hello World!']]);
});
test('whole -next group waits before commit; repeated clicks and internal next cannot advance',async()=>{
 const f=fixture(),wait=deferred(),loading=f.load('Core/util/sceneCharacterLoading.ts'),next=f.load('Core/controller/gamePlay/nextSentence.ts');let observed;
 loading.registerSceneCharacterLoadingHooks({prepareStage:async s=>{observed=s;await wait.promise;},prepareScene:async()=>{}});
 const p=next.nextSentence();await next.nextSentence();await next.continueSentence();
 assert.equal(observed.roles.length,2);assert.deepEqual(f.calls,['click','forward']);
 wait.resolve();await p;assert.deepEqual(f.calls,['click','forward',['commit','new',2],'performs']);
 assert.equal(loading.getCharacterLoadingStatus().phase,'idle');
});
test('failed group retries without executing scripts a second time',async()=>{
 const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts'),next=f.load('Core/controller/gamePlay/nextSentence.ts');let n=0;
 loading.registerSceneCharacterLoadingHooks({prepareStage:async()=>{if(++n===1)throw Error('gpu');},prepareScene:async()=>{}});
 await next.nextSentence();assert.equal(loading.getCharacterLoadingStatus().phase,'error');await next.nextSentence();assert.equal(f.calls.filter(x=>x==='forward').length,1);
 await loading.retryCharacterLoading();assert.equal(n,2);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='commit').length,1);assert.equal(f.calls.filter(x=>x==='forward').length,1);
});
test('cancelled group does not publish late results and can retry on the next user click',async()=>{
 const f=fixture(),wait=deferred(),loading=f.load('Core/util/sceneCharacterLoading.ts'),next=f.load('Core/controller/gamePlay/nextSentence.ts');let n=0;
 loading.registerSceneCharacterLoadingHooks({prepareStage:()=>++n===1?wait.promise:Promise.resolve(),prepareScene:async()=>{}});
 const p=next.nextSentence();loading.cancelCharacterLoading();wait.resolve();await p;
 assert.equal(f.calls.some(x=>Array.isArray(x)),false);await next.nextSentence();assert.equal(f.calls.filter(x=>x==='forward').length,1);assert.equal(n,2);
});
test('reset invalidates an evaluated group instead of submitting it to a new scene',async()=>{
 const f=fixture(),wait=deferred(),loading=f.load('Core/util/sceneCharacterLoading.ts'),next=f.load('Core/controller/gamePlay/nextSentence.ts');
 loading.registerSceneCharacterLoadingHooks({prepareStage:()=>wait.promise,prepareScene:async()=>{}});
 const p=next.nextSentence();next.cancelPendingForward();f.WebGAL.sceneManager.sceneData.currentScene={sceneUrl:'new'};wait.resolve();await p;
 assert.equal(f.calls.some(x=>Array.isArray(x)),false);assert.equal(loading.getCharacterLoadingStatus().phase,'idle');
});

test('auto-play removes a pending timer during loading and schedules a fresh delay after readiness',async()=>{
 const f=fixture(),loading=f.load('Core/util/sceneCharacterLoading.ts');
 f.WebGAL.gameplay.autoInterval=null;f.WebGAL.gameplay.autoTimeout=null;f.WebGAL.gameplay.isAuto=false;
 f.WebGAL.gameplay.performController.performList=[];
 const saved={setInterval:global.setInterval,clearInterval:global.clearInterval,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};
 let interval,scheduled=[],cleared=[];
 global.setInterval=cb=>{interval=cb;return 11;};global.clearInterval=()=>{};
 global.setTimeout=(cb,delay)=>{scheduled.push({cb,delay});return scheduled.length;};global.clearTimeout=id=>cleared.push(id);
 try {
  const auto=f.load('Core/controller/gamePlay/autoPlay.ts');auto.switchAuto();interval();assert.equal(scheduled.length,1);
  const ticket=loading.beginCharacterLoading('stage');interval();assert.deepEqual(cleared,[1]);assert.equal(f.WebGAL.gameplay.autoTimeout,null);
  interval();assert.equal(scheduled.length,1);ticket.succeed();interval();assert.equal(scheduled.length,2);assert.equal(scheduled[1].delay,250);
  auto.stopAuto();
 }finally{Object.assign(global,saved);}
});
