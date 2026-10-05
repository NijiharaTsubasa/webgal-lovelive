const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { isEqual, cloneDeep } = require('lodash');

const filename = path.resolve(__dirname, '../src/Core/controller/stage/pixi/PixiController.ts');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['changeModelFocusByKey', 'updateL2dFocusByKey']);
const methods = [];
function visit(node) {
  if (ts.isMethodDeclaration(node) && names.has(node.name.getText(source))) methods.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`class Stage { ${methods.join('\n')} }`, {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
}).outputText;
const baseFocusParam = {x:0,y:0,instant:false};
const Stage = new Function('isEqual','cloneDeep','baseFocusParam','baseBlinkParam',compiled+'\nreturn Stage;')(
  isEqual,cloneDeep,baseFocusParam,{});

test('Focus targets the active glTF instance and leaves retiring and unrelated actors alone',()=>{
  const stage = new Stage(),calls=[];
  stage.figureObjects=[
    {key:'a',sourceType:'gltf',isExiting:true,gltfRuntime:{setFocus:value=>calls.push(['retiring',value])}},
    {key:'a',sourceType:'gltf',gltfRuntime:{setFocus:value=>calls.push(['a',value])}},
    {key:'b',sourceType:'gltf',gltfRuntime:{setFocus:value=>calls.push(['b',value])}},
  ];
  stage.changeModelFocusByKey('a',{x:.6,y:-.2,instant:true});
  stage.changeModelFocusByKey('b',{x:-.3,y:.4,instant:false});
  assert.deepEqual(calls,[['a',{x:.6,y:-.2,instant:true}],['b',{x:-.3,y:.4,instant:false}]]);
});

test('native Live2D still merges Focus state and calls its existing controller only for changes',()=>{
  const stage = new Stage(),calls=[];
  stage.live2dFigureRecorder=[{target:'native',focus:{x:.5,y:.25,instant:true}}];
  stage.figureObjects=[{key:'native',sourceType:'live2d',pixiContainer:{children:[
    {internalModel:{focusController:{focus:(...args)=>calls.push(args)}}},
  ]}}];
  stage.changeModelFocusByKey('native',{x:-.5});
  assert.deepEqual(calls,[[-.5,.25,true]]);
  assert.deepEqual(stage.live2dFigureRecorder[0].focus,{x:-.5,y:.25,instant:true});
  stage.changeModelFocusByKey('native',{x:-.5,y:.25,instant:true});
  assert.equal(calls.length,1);
});
