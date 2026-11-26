'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const start=source.indexOf('// The Washington farm clock is independent');
const end=source.indexOf('// Navigation and account changes',start);
assert.ok(start>=0&&end>start,'Exercise the shipped greeting implementation');
const clockSource=source.slice(start,end);

function harness(instant='2026-11-01T19:59:59.500Z'){
  let now=Date.parse(instant),nextId=0;
  const elements=new Map(),listeners=new Map(),timers=new Map(),previews=[];
  class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({Date:FakeDate,Intl,Number,
    profile:{firstName:'Maria',language:'English'},
    $:selector=>{if(!elements.has(selector))elements.set(selector,{textContent:''});return elements.get(selector);},
    window:{addEventListener:(event,callback)=>listeners.set('window:'+event,callback)},
    document:{hidden:false,addEventListener:(event,callback)=>listeners.set('document:'+event,callback)},
    setTimeout:(callback,delay)=>{const id=++nextId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),updateDeliveryUi:value=>previews.push(value)});
  vm.runInContext(clockSource,context);
  return {context,elements,listeners,timers,previews,
    setTime:value=>{now=Date.parse(value);},
    tick:()=>{assert.equal(timers.size,1);const [id,timer]=timers.entries().next().value;timers.delete(id);timer.callback();}};
}

test('greeting follows Pacific morning, noon and evening boundaries',()=>{
  const {context}=harness();
  for(const [instant,greeting]of[
    ['2026-10-31T11:59:59Z','Good evening'], // 04:59 PDT
    ['2026-10-31T12:00:00Z','Good morning'],
    ['2026-10-31T18:59:59Z','Good morning'],
    ['2026-10-31T19:00:00Z','Good afternoon'],
    ['2026-11-01T00:59:59Z','Good afternoon'],
    ['2026-11-01T01:00:00Z','Good evening'],
    ['2026-11-01T07:00:00Z','Good evening']
  ])assert.equal(context.farmClock(instant).greeting,greeting,instant);
});

test('date rolls over at Pacific midnight, not UTC midnight',()=>{
  const {context}=harness();
  assert.match(context.farmClock('2026-11-01T06:59:59Z').dateLabel,/SATURDAY, OCTOBER 31/);
  assert.match(context.farmClock('2026-11-01T07:00:00Z').dateLabel,/SUNDAY, NOVEMBER 1/);
});

test('the same instant gives the same Washington greeting on non-Pacific devices',()=>{
  const original=process.env.TZ;
  try{
    for(const zone of['UTC','Asia/Tokyo','America/New_York']){
      process.env.TZ=zone;const {context}=harness();
      assert.equal(context.farmClock('2026-11-01T20:00:00Z').greeting,'Good afternoon',zone);
      assert.match(context.farmClock('2026-11-01T06:59:59Z').dateLabel,/OCTOBER 31/,zone);
    }
  }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});

test('greeting remains correct across both daylight-saving transitions',()=>{
  const {context}=harness();
  for(const instant of['2026-03-08T09:59:59Z','2026-03-08T10:00:00Z','2026-11-01T08:59:59Z','2026-11-01T09:00:00Z'])assert.equal(context.farmClock(instant).greeting,'Good evening',instant);
  assert.equal(context.farmClock('2026-03-08T19:00:00Z').greeting,'Good afternoon');
  assert.equal(context.farmClock('2026-11-01T19:59:59Z').greeting,'Good morning');
  assert.equal(context.farmClock('2026-11-01T20:00:00Z').greeting,'Good afternoon');
  assert.equal(context.farmClock('2026-11-02T02:00:00Z').greeting,'Good evening');
});

test('Spanish greeting and date follow the selected language',()=>{
  const {context,elements}=harness();context.profile.language='Español';
  for(const [instant,greeting]of[['2026-11-01T17:00:00Z','Buenos días'],['2026-11-01T21:00:00Z','Buenas tardes'],['2026-11-02T03:00:00Z','Buenas noches']])assert.equal(context.farmClock(instant,'Español').greeting,greeting);
  context.refreshWelcome('2026-11-01T21:00:00Z');
  assert.equal(elements.get('#welcomeGreeting').textContent,'Buenas tardes');
  assert.match(elements.get('#dateLabel').textContent,/DOMINGO.*NOVIEMBRE/);
});

test('minute boundary refresh updates the greeting and unsent preview without a brief request',()=>{
  const h=harness();
  assert.equal(h.elements.get('#welcomeGreeting').textContent,'Good morning');
  assert.equal([...h.timers.values()][0].delay,525);
  h.setTime('2026-11-01T20:00:00.025Z');h.tick();
  assert.equal(h.elements.get('#welcomeGreeting').textContent,'Good afternoon');
  assert.equal(h.previews.at(-1),Date.parse('2026-11-01T20:00:00.025Z'));
  assert.doesNotMatch(clockSource,/fetch\(|loadDailyBrief\(|saveCloudState\(/);
});

test('tab return, browser focus and restored pages refresh immediately without duplicate timers',()=>{
  const h=harness();h.context.document.hidden=true;
  h.listeners.get('document:visibilitychange')();assert.equal(h.timers.size,0);
  h.setTime('2026-11-02T03:00:00Z');h.context.document.hidden=false;
  for(const event of['document:visibilitychange','window:focus','window:pageshow']){
    h.listeners.get(event)();assert.equal(h.elements.get('#welcomeGreeting').textContent,'Good evening');assert.equal(h.timers.size,1);
  }
});

test('farmer names use text content, and clearing the profile resets the welcome name',()=>{
  const h=harness();h.context.profile.firstName='<img src=x onerror=alert(1)>';
  h.context.refreshWelcome();assert.equal(h.elements.get('#welcomeName').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(h.elements.get('#welcomeName').innerHTML,undefined);
  h.context.profile=null;h.context.refreshWelcome();assert.equal(h.elements.get('#welcomeName').textContent,'farmer');
  assert.match(source,/function applyProfile\(\)\{\s*refreshWelcome\(\);/);
});

test('invalid clocks fail to a neutral greeting, never an invented time',()=>{
  const {context}=harness();assert.equal(context.farmClock('invalid').greeting,'Hello');assert.equal(context.farmClock('invalid','Spanish').greeting,'Hola');
});

test('markup is neutral until the clock renders and preview has no hardcoded morning',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/<span id="welcomeGreeting">Hello<\/span>/);
  assert.doesNotMatch(html,/Good morning, <span id="welcomeName">/);
  const preview=source.slice(source.indexOf('function updateDeliveryUi('),source.indexOf('\n',source.indexOf('function updateDeliveryUi(')));
  assert.match(preview,/farmClock\(now,profile.language\).greeting/);
  assert.doesNotMatch(preview,/`Morning, /);
});

test('unsent message preview uses the same current greeting without sending or inserting HTML',()=>{
  const h=harness();
  const first=source.indexOf('function updateDeliveryUi('),last=source.indexOf('\n',first);
  vm.runInContext(source.slice(first,last),h.context);
  h.context.profile={firstName:'<b>Maria</b>',language:'English',location:'Moses Lake, WA',priorityField:'Block 1'};
  h.context.refreshWelcome('2026-11-01T21:00:00Z');
  const preview=h.elements.get('#whatsappPreviewCopy');
  assert.match(preview.textContent,/^Good afternoon, <b>Maria<\/b>\./);
  assert.match(preview.textContent,/unsent draft/);assert.equal(preview.innerHTML,undefined);
  h.context.profile.language='Español';h.context.refreshWelcome('2026-11-02T03:00:00Z');
  assert.match(preview.textContent,/^Buenas noches/);assert.match(preview.textContent,/no se ha enviado/);
});
