const fs = require('fs'), Module = require('module'), path = require('path'), ts = require('typescript');
const assert = require('node:assert/strict'), test = require('node:test');
function load(file) {
 const filename = path.resolve(__dirname, '../src', file);
 const m = new Module(filename, module);
 m.require = name => name === '@/Core/Modules/stage/stageInterface'
  ? {figureStateKeyByPosition:{center:'figName',left:'figNameLeft',right:'figNameRight'}} : require(name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
 return m.exports;
}
const {resolveNameplate} = load('Stage/TextBox/nameplate.ts');
const rules = [{keywords:['/ch0001_'],style:'honoka'}, {keywords:['/ch0002_'],style:'eli'}];
const base = {showName:'穗乃果',dialogueFigure:'actor',freeFigure:[{key:'actor',name:'game/figure/3d/figure/llas/ch0001_co0002_member/config.json'}]};
test('matches associated free figure, including encoded and Windows paths',()=>{
 assert.equal(resolveNameplate(base,rules),'honoka');
 assert.equal(resolveNameplate({...base,freeFigure:[{key:'actor',name:'GAME\\figure\\%63h0001_co0002\\config.json'}]},rules),'honoka');
});
test('uses the selected position and responds to replacement without guessing names',()=>{
 assert.equal(resolveNameplate({...base,dialogueFigure:'fig-left',freeFigure:[],figNameLeft:'/ch0002_co0001/config.json'},rules),'eli');
 assert.equal(resolveNameplate({...base,freeFigure:[{key:'actor',name:'/ch0002_co0001/config.json'}]},rules),'eli');
});
test('narration, missing targets and unsupported themes use the default',()=>{
 for(const s of [{...base,showName:''},{...base,dialogueFigure:''},{...base,freeFigure:[]}]) assert.equal(resolveNameplate(s,rules),undefined);
 assert.equal(resolveNameplate(base,undefined),undefined);
 assert.equal(resolveNameplate(base,{bad:true}),undefined);
});

test('composed figures match the head package only, including higher-priority body rules',()=>{
 const template=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../themes/llas/template.json'),'utf8'));
 const match=p=>resolveNameplate({...base,freeFigure:[{key:'actor',name:p}]},template['nameplate-rules']);
 for(let member=36;member<=40;member++) {
  const head=`game/3d/figure/bangdream/${String(member).padStart(3,'0')}_cos_live_default/config.json`;
  assert.equal(match(head),'mygo');
  assert.equal(match(`${head}+game/3d/figure/llas/ch0001_co0001/config.json`),'mygo');
 }
 for(const member of ['035','041','1036']) assert.equal(match(`/bangdream/${member}_cos_live_default/config.json`),undefined);
 assert.equal(match('/unknown/config.json+/037_cos_live_default/config.json'),undefined);
 assert.equal(match('/ch0002_co0001/config.json+/037_cos_live_default/config.json'),'llas-ch0002');
 assert.equal(match('GAME\\FIGURE\\%30%33%37_cos_live_default\\CONFIG.JSON+/ch0001_co0001/config.json'),'mygo');
 assert.equal(resolveNameplate({...base,dialogueFigure:'fig-left',freeFigure:[],figNameLeft:'/037_cos_live_default/config.json+/ch0001_co0001/config.json'},template['nameplate-rules']),'mygo');
});
test('ignores malformed rules, rejects unsafe style names, and takes first match',()=>{
 assert.equal(resolveNameplate(base,[null,{keywords:[''],style:'x'},{keywords:['ch0001'],style:'x]evil'},...rules]),'honoka');
 assert.equal(resolveNameplate({...base,freeFigure:[{key:'actor',name:'/ch0001_%oops'}]},rules),'honoka');
});

test('LLAS theme rules reference complete assets and preserve the default with the upstream parser',()=>{
 const root=path.resolve(__dirname,'../../../themes/llas');
 const template=JSON.parse(fs.readFileSync(path.join(root,'template.json'),'utf8'));
 const Parser=require('../../parser/build/cjs/index.cjs').default;
 const parser=new Parser();
 const styles=parser.parseScssToWebgalStyleObj(fs.readFileSync(path.join(root,'Stage/TextBox/textbox.scss'),'utf8')).classNameStyles.TextBox_ShowName_Background;
 assert.match(styles,/llas-dialog-name\.png/);
 for(const rule of template['nameplate-rules']) {
  assert.match(styles,new RegExp('data-nameplate=[\'\"]'+rule.style));
  for(const keyword of rule.keywords.filter(k=>!k.includes("?"))) assert.equal(resolveNameplate({...base,freeFigure:[{key:'actor',name:`game/figure/3d/figure${keyword}co0001_member/config.json`}]},template['nameplate-rules']),rule.style);
 }
 const choose=parser.parseScssToWebgalStyleObj(fs.readFileSync(path.join(root,'Stage/Choose/choose.scss'),'utf8')).classNameStyles;
 for(const key of ['Choose_item','Choose_item_disabled']) assert.match(choose[key],/llas-choice-background\.png/);
});


test('costume wildcards select the middle member digits and band keywords match anywhere',()=>{
 const template=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../themes/llas/template.json'),'utf8'));
 const match=p=>resolveNameplate({...base,freeFigure:[{key:'actor',name:p}]},template['nameplate-rules']);
 for(const member of ['1021','1022','1023','1031','1032','1033','1041','1042','1043','1051','1052']) {
  assert.equal(match(`custom/models/3d_costume_1003${member}01/config.json`),`hasunosora-${member}`);
  assert.equal(match(`custom/models/3d_costume_9999${member}88/config.json`),`hasunosora-${member}`);
 }
 assert.equal(match('/3d_costume_123102101/config.json'),undefined);
 assert.equal(match('/3d_costume_123/102101/config.json'),undefined);
 assert.equal(match('/3d_costume_1003900701/config.json'),undefined);
 for(const name of ['anon','rana','soyo','taki','tomori']) assert.equal(match(`custom/prefix_${name.toUpperCase()}_costume/model.json`),'mygo');
 for(const name of ['mutsumi','nyamu','uika','umiri','sakiko']) assert.equal(match(`custom/prefix_${name}_costume/model.json`),'ave-mujica');
});

test('LLAS playback indicators use separate auto and skip states with original icons',()=>{
 const root=path.resolve(__dirname,'../../../themes/llas');
 const Parser=require('../../parser/build/cjs/index.cjs').default;
 const source=fs.readFileSync(path.join(root,'Stage/TextBox/textbox.scss'),'utf8');
 const styles=new Parser().parseScssToWebgalStyleObj(source).classNameStyles.TextBox_main;
 assert.match(styles,/data-playback='auto'[\s\S]*content: 'AUTO'[\s\S]*llas-auto\.png/);
 assert.match(styles,/data-playback='skip'[\s\S]*content: 'SKIP'[\s\S]*llas-skip\.png/);
 assert.match(styles,/display: none/);
 assert.match(styles,/\[data-auto='true'\]:not\(\[data-playback\]\)::after/);
 assert.match(styles,/\[data-auto\]:not\(\[data-playback\]\)::after/);
 for(const name of ['llas-auto.png','llas-skip.png']) {
  const image=fs.readFileSync(path.join(root,'assets',name));
  assert.equal(image.readUInt32BE(16),44); assert.equal(image.readUInt32BE(20),44);
 }
});
