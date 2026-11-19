'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function script() {
  const text = readFileSync(resolve(__dirname, '../src/OnlyDM/WebViewScripts.cs'), 'utf8');
  const start = text.indexOf('return $$"""', text.indexOf('public static string BuildInboxScript(')) + 'return $$"""'.length;
  const end = text.indexOf('""";', start);
  return text.slice(start, end).replaceAll('{{paletteJson}}', '{}').replaceAll('{{uiJson}}', '{}')
    .replaceAll('{{shellScale}}', '1').replaceAll('{{JsonSerializer.Serialize(notificationsOnly)}}', 'false')
    .replace(/\}\)\(\);\s*$/, 'globalThis.authTest={start:startInboxProjection,render:renderThreadList}; })();');
}

function surface(path, stale = false) {
  const messages = [], listeners = new Map(), listenerCounts = new Map(), removed = new Set(), timers = [];
  const classes = new Set(stale ? ['onlydm-source-hidden', 'onlydm-account-hidden'] : []);
  const form = { id:'official-form', classList:{ add:c=>classes.add(c), remove:(...cs)=>cs.forEach(c=>classes.delete(c)) } };
  const hiddenInput = {tagName:'INPUT',closest:()=>classes.has('onlydm-source-hidden')?form:null};
  Object.defineProperty(hiddenInput,'value',{get(){throw Error('OnlyDM must not read a verification code');}});
  const nodes = stale ? new Map([
    ['OnlyDmShell',{id:'OnlyDmShell',querySelector:()=>null,remove:()=>removed.add('OnlyDmShell')}],
    ['onlydm-inbox-style',{remove:()=>removed.add('onlydm-inbox-style')}],
    ['onlydm-account-style',{remove:()=>removed.add('onlydm-account-style')}],
  ]) : new Map();
  const document = {
    readyState:'loading',body:{children:[form]},activeElement:hiddenInput,
    addEventListener:(name,callback)=>{listeners.set(name,callback);listenerCounts.set(name,(listenerCounts.get(name)||0)+1);},
    getElementById:id=>removed.has(id)?null:nodes.get(id)||null,
    querySelectorAll:selector=>{
      if(selector.includes('onlydm-source-hidden'))return [form];
      if(selector==='div[role="button"][tabindex="0"]')return [];
      if(selector==='#OnlyDmShell .onlydm-thread-row')return [];
      if(selector==='a[href^="/"]')return [];
      throw Error('Unexpected auth-page traversal: '+selector);
    },
  };
  const context={document,location:{pathname:path,origin:'https://www.instagram.com'},
    MutationObserver:class{observe(){}disconnect(){}},
    setTimeout:()=>0,clearTimeout(){},setInterval:(fn,ms)=>timers.push(ms),clearInterval(){},
    chrome:{webview:{postMessage:m=>messages.push(m),addEventListener(){}}}};
  context.window=context;
  runInNewContext(script(),context);
  return {context,messages,listeners,listenerCounts,classes,removed,timers,nodes};
}

for(const path of ['/accounts/login/','/challenge/email/','/checkpoint/','/accounts/two_factor/',
  '/accounts/onetap/','/auth_platform/','/auth_platform/codeentry/']) {
  test('official authentication is exposed without projecting or reading fields: '+path,()=>{
    const state=surface(path);
    state.context.authTest.start();
    assert.deepEqual(state.messages.map(m=>m.type),['login-ready']);
    assert.deepEqual(state.timers,[]);
    assert.equal(state.classes.size,0);
  });
}

test('a same-document authentication step removes stale projection and preserves native keys',()=>{
  const state=surface('/auth_platform/codeentry/',true);
  state.context.authTest.render();
  assert.ok(state.removed.has('OnlyDmShell'));
  assert.ok(state.removed.has('onlydm-inbox-style'));
  assert.equal(state.classes.size,0);
  const event={key:'Enter',preventDefault(){this.prevented=true;}};
  state.listeners.get('keydown')(event);
  assert.notEqual(event.prevented,true,'the official form keeps its Enter submit action');
  assert.equal(state.messages.some(m=>m.type==='request-open'),false);
  assert.equal(state.messages.some(m=>m.type==='projection-error'),false);
});
test('authentication followed by same-document inbox return keeps a single projection listener',()=>{
  const state=surface('/auth_platform/codeentry/',true);
  state.context.authTest.start();
  state.context.location.pathname='/direct/inbox/';
  state.context.document.readyState='complete';
  state.nodes.set('OnlyDmShell',{id:'OnlyDmShell',querySelector:()=>null});
  state.nodes.set('onlydm-inbox-style',{});
  state.removed.clear();
  runInNewContext(script(),state.context);
  assert.equal(state.listenerCounts.get('keydown'),1,'re-enter the existing closure instead of registering a second keyboard handler');
  assert.equal(state.messages.some(m=>m.type==='projection-error'),false);
  assert.equal(state.messages.at(-1).type,'inbox-ready');
});