const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {EventEmitter} = require('node:events');
const test = require('node:test');
const ts = require('typescript');

test('removing a loading figure cancels its captured timeline before transform destruction', () => {
  const container = new EventEmitter();
  container.destroyed = false;
  container.scale = {x:1,y:1};
  const target = {pixiContainer:container};
  let update, stops=0;
  const imports = {
    popmotion:{animate(options){update=options.onUpdate;return {stop(){stops++;}};}},
    '@/Core/WebGAL':{WebGAL:{gameplay:{pixiStage:{getStageObjByKey(){return target;}}}}},
    '@/Core/controller/stage/pixi/PixiController':{__esModule:true,default:{assignTransform(actor,values){
      assert.equal(actor.destroyed,false,'Never touch a destroyed Pixi transform');
      Object.assign(actor,values);
    }}},
  };
  const filename=path.resolve(__dirname,'../src/Core/controller/stage/pixi/animations/timeline.ts');
  const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true,
  }}).outputText;
  const sourceModule=new Module(filename,module);
  sourceModule.paths=Module._nodeModulePaths(path.dirname(filename));
  sourceModule.require=name=>imports[name]??Module.prototype.require.call(sourceModule,name);
  sourceModule._compile(compiled,filename);
  const timeline=sourceModule.exports.generateTimelineObj([
    {position:{x:0},scale:{x:1,y:1},duration:0},
    {position:{x:20},scale:{x:2,y:2},duration:1200},
  ],'broken',1200);
  update({x:10,scaleX:1.5,scaleY:1.5});
  assert.equal(container.scale.x,1.5);
  container.destroyed=true;
  container.scale=null;
  container.emit('destroyed');
  assert.equal(stops,1);
  assert.doesNotThrow(()=>update({scaleX:1.8,scaleY:1.8}));
  assert.doesNotThrow(()=>timeline.setStartState());
  assert.doesNotThrow(()=>timeline.setEndState());
  assert.doesNotThrow(()=>timeline.forceStopWithoutSetEndState());
});
