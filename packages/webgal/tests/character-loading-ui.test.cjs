const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
function load(relative, imports, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, setTimeout, clearTimeout, ...globals, require(name) {
    assert.ok(Object.hasOwn(imports, name), `unexpected import ${name}`);
    return imports[name];
  } });
  return exports;
}

test('old and invalid saved settings normalize to scene; on-demand survives and reset restores scene', () => {
  const reducer = load('store/userDataReducer.ts', {
    '@/config/language': { language: { zhCn: 0 } },
    '@/store/userDataInterface': { textSize: { medium: 1 }, voiceOption: { no: 1 }, fullScreenOption: { off: 1 } },
    '@reduxjs/toolkit': require('@reduxjs/toolkit'),
    'lodash/cloneDeep': { default: require('lodash/cloneDeep') },
  });
  const source = ts.createSourceFile('storage.ts', fs.readFileSync(path.join(root, 'Core/controller/storage/storageController.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['normalizeUserData', 'isObject'].includes(n.name?.text));
  const code = ts.transpileModule(functions.map(n => n.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const normalize = new Function('initState', 'cloneDeep', `${code}; return normalizeUserData;`)(reducer.initState, require('lodash/cloneDeep'));
  assert.equal(reducer.initState.optionData.characterLoadingMode, 'scene');
  assert.equal(reducer.initState.optionData.meshClothEnabled, false);
  for (const value of [undefined, 'unknown', null, 5, 'scene', 'on-demand']) {
    const input = { optionData: { characterLoadingMode: value, volumeMain: 72 }, globalGameVar: { flag: true } };
    const result = normalize(input);
    assert.equal(result.optionData.characterLoadingMode, value === 'on-demand' ? 'on-demand' : 'scene');
    assert.equal(result.optionData.volumeMain, 72);
    assert.equal(result.globalGameVar.flag, true);
    assert.equal(input.optionData.characterLoadingMode, value);
  }
  assert.equal(normalize({}).optionData.characterLoadingMode, 'scene');
  for (const value of [undefined, null, 'true', 1, false, true]) assert.equal(normalize({optionData:{meshClothEnabled:value}}).optionData.meshClothEnabled,value === true);
  const cloth = reducer.default(undefined,reducer.setOptionData({key:'meshClothEnabled',value:true}));
  assert.equal(reducer.default(cloth,reducer.resetOptionSet()).optionData.meshClothEnabled,false);
  const changed = reducer.default(undefined, reducer.setOptionData({ key: 'characterLoadingMode', value: 'on-demand' }));
  assert.equal(changed.optionData.characterLoadingMode, 'on-demand');
  assert.equal(reducer.default(changed, reducer.resetOptionSet()).optionData.characterLoadingMode, 'scene');
});

test('already prepared stage transitions never flash loading; unfinished preparation shows after a brief wait', () => {
  let status = { phase: 'idle' }, listener, state, timer, cleared = 0;
  const effects = [];
  const ui = load('UI/CharacterLoading/CharacterLoading.tsx', {
    react: { useRef() { return {current:null}; }, useState(initial) { if (!state) state = initial(); return [state, value => { state = value; }]; }, useEffect(effect) { effects.push(effect); } },
    'react/jsx-runtime': { jsx(type, props) { return { type, props }; }, jsxs(type, props) { return { type, props }; } },
    'react-redux': { useSelector(fn) { return fn({ userData: { optionData: { characterLoadingMode: 'on-demand' } } }); } },
    '@/Core/util/sceneCharacterLoading': {
      getCharacterLoadingStatus: () => status, subscribeCharacterLoading: fn => { listener = fn; return () => {}; },
      setCharacterLoadingMode() {}, retryCharacterLoading() {}, cancelCharacterLoading() {},
    },
    '@/hooks/useTrans': { default: () => key => key }, '@/Core/util/logger': { logger: { error() {} } },
    '@/Core/controller/gamePlay/fastSkip': { stopAll() {} }, './characterLoading.module.scss': { default: {scene:'scene',stage:'stage'} }, '@/hooks/useApplyStyle': {default:()=> (name,fallback)=>fallback},
  }, { setTimeout(fn, delay) { assert.equal(delay, 150); timer = fn; return 1; }, clearTimeout() { timer = undefined; cleared++; } }).default;
  ui(); const cleanup = effects[0]();
  status = { phase: 'loading', kind: 'stage' }; listener(status);
  assert.equal(ui(), null, 'fast prepared transition must keep old picture without overlay');
  status = { phase: 'idle' }; listener(status);
  assert.equal(timer, undefined, 'commit before timeout cancels loading UI');
  assert.equal(ui(), null);
  status = { phase: 'loading', kind: 'scene' }; listener(status);
  assert.equal(ui(), null, 'a preloaded scene transition must not flash either');
  status = { phase: 'idle' }; listener(status); assert.equal(timer, undefined);
  status = { phase: 'loading', kind: 'stage' }; listener(status);
  timer(); assert.ok(ui(), 'remaining wait displays loading');
  status = { phase: 'error', kind: 'stage' }; listener(status); assert.ok(ui());
  cleanup(); assert.ok(cleared > 0);
});

test('all registered languages supply settings explanations and loading actions', () => {
  for (const language of ['zh-cn','zh-tw','en','jp','fr','de','pt-br','ko']) {
    const translations = load(`translations/${language}.ts`, {}).default;
    const option = translations.menu.options.pages.system.options.characterLoading;
    for (const value of [option.title, option.options.scene, option.options.onDemand, option.description.scene, option.description.onDemand,
      translations.characterLoading.preparing, translations.characterLoading.failed, translations.characterLoading.retry]) {
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0, language);
    }
  }
});

test('scene loading blocks input while stage loading stays transparent; only retry remains', async () => {
  let status = { phase: 'idle' }, listener, unsubscribeCount = 0, retried = 0, cancelled = 0, mode, autoStopped = false;
  let state, effects = []; const handlers = new Map(); let removed = 0;
  class Element { constructor(inside=false) { this.inside=inside; } closest() { return this.inside; } }
  const ui = load('UI/CharacterLoading/CharacterLoading.tsx', {
    react: { useRef() { return {current:null}; }, useState(initial) { if (!state) state = initial(); return [state, value => { state = value; }]; }, useEffect(effect) { effects.push(effect); } },
    'react/jsx-runtime': { jsx(type, props) { return {type, props}; }, jsxs(type, props) { return {type, props}; } },
    'react-redux': { useSelector(fn) { return fn({userData:{optionData:{characterLoadingMode:'on-demand'}}}); } },
    '@/Core/util/sceneCharacterLoading': {
      getCharacterLoadingStatus: () => status,
      subscribeCharacterLoading: fn => { listener = fn; return () => { unsubscribeCount++; }; },
      setCharacterLoadingMode: value => { mode = value; },
      retryCharacterLoading: async () => { retried++; }, cancelCharacterLoading: () => { assert.ok(autoStopped); cancelled++; },
    },
    '@/hooks/useTrans': { default: () => key => key },
    '@/Core/util/logger': { logger: {error() {}} },
    '@/Core/controller/gamePlay/fastSkip': {stopAll() {autoStopped = true;}},
    './characterLoading.module.scss': { default: {scene:'scene',stage:'stage'} }, '@/hooks/useApplyStyle': {default:()=> (name,fallback)=>fallback},
  }, { Element, document: {addEventListener(type, fn, options) { assert.equal(options.capture,true); handlers.set(type,fn); },removeEventListener() { removed++; }} }).default;
  assert.equal(ui(), null);
  const cleanup = effects[0](); effects[2](); const unblock = effects[3]();
  const blocked = () => { let blocked=0; handlers.get('click')({target:new Element(),preventDefault(){blocked++;},stopImmediatePropagation(){blocked++;}}); return blocked; };
  status={phase:'loading',kind:'scene'}; assert.equal(blocked(),2,'scene waits block input before the visual delay');
  status={phase:'loading',kind:'stage'}; assert.equal(blocked(),0,'stage waits allow menus and navigation');
  status={phase:'error',kind:'scene'}; let insideBlocked=false; handlers.get('click')({type:'click',target:new Element(true),preventDefault(){insideBlocked=true;}}); assert.equal(insideBlocked,false,'retry stays operable');
  handlers.get('keydown')({type:'keydown',key:'Escape',target:new Element(true),preventDefault(){insideBlocked=true;},stopImmediatePropagation(){}}); assert.equal(insideBlocked,true,'retry focus cannot leak global shortcuts');
  assert.equal(mode, 'on-demand');
  function buttons(node, result=[]) {
    if (!node || typeof node !== 'object') return result;
    if (node.type === 'button') result.push(node);
    for (const child of [node.props?.children].flat()) buttons(child, result);
    return result;
  }
  status = {phase:'loading'}; listener(status);
  let tree = ui();
  assert.equal(buttons(tree).length, 0);
  assert.equal(tree.props['data-scene-loading'], undefined);
  status = {phase:'error', error: new Error('private URL')}; listener(status);
  tree = ui();
  const actions = buttons(tree);
  assert.equal(actions.length, 1);
  actions[0].props.onClick(); await Promise.resolve();

  assert.equal(retried, 1); assert.equal(cancelled, 0);
  listener({phase:'idle'}); assert.equal(ui(), null);
  cleanup(); unblock(); assert.equal(unsubscribeCount, 1); assert.equal(removed,6);
});


test('cloth switch is saved at the title, invalidates prepared actors, and is locked during play', () => {
  const current = { GUI:{showTitle:true},userData:{optionData:{meshClothEnabled:false,characterLoadingMode:'scene'}} };
  const dispatched=[];let saved=0,released=0;
  const ui=load('UI/Menu/Options/ThreeD.tsx',{
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'react-redux':{useSelector:fn=>fn(current),useDispatch:()=>action=>dispatched.push(action)},
    '@/store/store':{webgalStore:{getState:()=>current}},
    '@/store/userDataReducer':{setOptionData:payload=>payload},
    '@/Core/controller/storage/storageController':{setStorage:()=>saved++},
    '@/Core/util/sceneCharacterLoading':{releaseSceneCharacters:()=>released++},
    '@/hooks/useTrans':{default:()=>(...keys)=>keys.length===1?keys[0]:keys},
    './options.module.scss':{default:{}},'./System/characterLoadingOption.module.scss':{default:{}},
    './NormalOption':{NormalOption:'option'},'./NormalButton':{NormalButton:'control'},
  }).ThreeD;
  function find(node,predicate){if(!node||typeof node!=='object')return;if(predicate(node))return node;for(const child of [node.props?.children].flat()){const value=find(child,predicate);if(value)return value;}}
  const control=find(ui(),node=>node.type==='control'&&node.props.textList[0]==='meshCloth.off');
  assert.equal(control.props.currentChecked,0);
  control.props.functionList[1]();
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)),[{key:'meshClothEnabled',value:true}]);
  assert.equal(saved,1);assert.equal(released,1);
  current.GUI.showTitle=false;
  control.props.functionList[0]();
  assert.equal(dispatched.length,1,'stale title handler must also reject an in-game click');
  const tree=ui();assert.ok(find(tree,node=>node.props?.['aria-disabled']===true));
  assert.ok(find(tree,node=>node.props?.children==='meshCloth.titleOnly'));
});


test('successful label navigation cancels a waiting stage batch before continuing; script jumps stay intact', () => {
  let status={phase:'loading',kind:'stage'}, valid=true; const calls=[];
  const jmp=load('Core/gameScripts/label/jmp.ts', {
    '@/Core/controller/gamePlay/nextSentence':{cancelPendingForward(){calls.push('cancel');},continueSentence(){calls.push('continue');}},
    '@/Core/gameScripts/label/jumpToLabel':{jumpToLabel(){return valid;}},
    '@/Core/util/sceneCharacterLoading':{getCharacterLoadingStatus:()=>status},
  }).jmp;
  jmp('target'); assert.deepEqual(calls,['cancel','continue']);
  calls.length=0; valid=false; jmp('missing'); assert.deepEqual(calls,[]);
  valid=true; status={phase:'idle'}; jmp('script'); assert.deepEqual(calls,['continue']);
});


test('loading theme can replace imagery and placement; anchor updates never overwrite theme positions', () => {
  const effects=[], properties=new Map(); let loadingKind="stage";
  const style={left:'30px',top:'40px',setProperty:(name,value)=>properties.set(name,value)};
  const indicator={style,parentElement:{clientWidth:1000,clientHeight:600,getBoundingClientRect:()=>({left:10,top:20,width:500,height:300})}};
  const component=load('UI/CharacterLoading/CharacterLoading.tsx',{
    react:{useState:initial=>[initial(),()=>{}],useRef:()=>({current:indicator}),useEffect:fn=>effects.push(fn)},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'react-redux':{useSelector:fn=>fn({userData:{optionData:{characterLoadingMode:'scene'}}})},
    '@/Core/util/sceneCharacterLoading':{getCharacterLoadingStatus:()=>({phase:'loading',kind:loadingKind})},
    '@/hooks/useTrans':{default:()=>key=>key}, '@/hooks/useApplyStyle':{default:()=>name=>`theme-${name}`},
    '@/Core/util/logger':{logger:{}}, './characterLoading.module.scss':{default:{stage:'stage',overlay:'overlay'}},
  },{
    document:{getElementById:()=>({getBoundingClientRect:()=>({right:410,bottom:270,width:300,height:100})})},
    ResizeObserver:class {observe(){} disconnect(){}},window:{addEventListener(){},removeEventListener(){}},
  }).default;
  const tree=component();
  const node=tree.props.children;
  assert.equal(node.props.className,'theme-CharacterLoading_stageIndicator');
  assert.equal(node.props.children[0].props.className,'theme-CharacterLoading_stageImage');
  assert.equal(node.props.children[0].props.role,'img');
  const cleanup=effects[1]();
  assert.equal(properties.get('--character-loading-anchor-x'),'800px');
  assert.equal(properties.get('--character-loading-anchor-y'),'500px');
  assert.equal(style.left,'30px'); assert.equal(style.top,'40px'); cleanup();
  loadingKind='scene'; const scene=component().props.children;
  assert.equal(scene.props.className,'theme-CharacterLoading_sceneIndicator');
  assert.equal(scene.props.children[0].props.className,'theme-CharacterLoading_sceneImage');
});
