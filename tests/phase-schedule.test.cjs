const test = require('node:test');
const assert = require('node:assert/strict');
const {pacificParts,shouldPrepare} = require('../phase-schedule');
const profile = {scheduleEnabled:true,briefTime:'06:30'};
const due = (now, overrides = {}) => shouldPrepare({profile,now:Date.parse(now),visible:true,...overrides});

test('morning preparation starts at the configured Pacific minute, not UTC or device calendar time',()=>{
  assert.equal(due('2026-10-03T13:29:59Z'),false);
  assert.equal(due('2026-10-03T13:30:00Z'),true);
  assert.equal(due('2026-10-03T17:00:00Z'),true,'returning after the requested time catches up');
  assert.equal(due('2026-12-03T14:29:59Z'),false);
  assert.equal(due('2026-12-03T14:30:00Z'),true,'winter schedule follows PST');
});

test('only explicit opt-in and a visible app permit scheduled preparation',()=>{
  for(const value of [undefined,null,false,0,1,'true','on']) {
    assert.equal(due('2026-10-03T17:00:00Z',{profile:{...profile,scheduleEnabled:value}}),false,JSON.stringify(value));
  }
  assert.equal(due('2026-10-03T17:00:00Z',{profile:null}),false);
  assert.equal(due('2026-10-03T17:00:00Z',{visible:false}),false);
  assert.equal(due('2026-10-03T17:00:00Z',{visible:true}),true);
});

test('missing or malformed local brief times are rejected instead of interpreted loosely',()=>{
  for(const briefTime of [undefined,null,'','6:30','06:3','24:00','23:60','-1:00','06:30:00',' 06:30','06:30 ','noon','2026-10-03T06:30',630]) {
    assert.equal(due('2026-10-03T17:00:00Z',{profile:{...profile,briefTime}}),false,JSON.stringify(briefTime));
  }
});

test('a saved brief suppresses duplicate delivery only for its Pacific calendar day',()=>{
  assert.equal(due('2026-10-03T17:00:00Z',{brief:{date:'2026-10-03'}}),false);
  assert.equal(due('2026-10-03T17:00:00Z',{brief:{date:'2026-10-02'}}),true);
  assert.equal(due('2026-10-03T17:00:00Z',{brief:null}),true);
  assert.equal(due('2026-10-04T06:59:00Z',{brief:{date:'2026-10-03'}}),false,'UTC tomorrow is still Pacific today');
  assert.equal(due('2026-10-04T07:00:00Z',{brief:{date:'2026-10-03'}}),false,'new Pacific day is before the morning schedule');
  assert.equal(due('2026-10-04T13:30:00Z',{brief:{date:'2026-10-03'}}),true);
});

test('Pacific midnight is represented as minute zero and supports a midnight schedule',()=>{
  assert.deepEqual(pacificParts(Date.parse('2026-10-03T07:00:00Z')),{date:'2026-10-03',minute:0});
  assert.deepEqual(pacificParts(Date.parse('2026-12-03T08:00:00Z')),{date:'2026-12-03',minute:0});
  assert.equal(due('2026-10-03T07:00:00Z',{profile:{...profile,briefTime:'00:00'}}),true);
  assert.equal(due('2026-10-03T07:00:00Z',{profile:{...profile,briefTime:'00:00'},brief:{date:'2026-10-03'}}),false);
});

test('spring-forward missing time catches up at 3 AM without changing the Pacific day',()=>{
  const springProfile={...profile,briefTime:'02:30'};
  assert.deepEqual(pacificParts(Date.parse('2026-03-08T09:59:00Z')),{date:'2026-03-08',minute:119});
  assert.deepEqual(pacificParts(Date.parse('2026-03-08T10:00:00Z')),{date:'2026-03-08',minute:180});
  assert.equal(due('2026-03-08T09:59:00Z',{profile:springProfile}),false);
  assert.equal(due('2026-03-08T10:00:00Z',{profile:springProfile}),true);
  assert.equal(due('2026-03-08T10:01:00Z',{profile:springProfile,brief:{date:'2026-03-08'}}),false);
});

test('fall-back repeated hour does not request another brief once that local day is saved',()=>{
  const autumnProfile={...profile,briefTime:'01:30'};
  for(const timestamp of ['2026-11-01T08:30:00Z','2026-11-01T09:30:00Z']) {
    assert.deepEqual(pacificParts(Date.parse(timestamp)),{date:'2026-11-01',minute:90});
    assert.equal(due(timestamp,{profile:autumnProfile}),true);
    assert.equal(due(timestamp,{profile:autumnProfile,brief:{date:'2026-11-01'}}),false);
  }
  assert.equal(due('2026-11-01T09:29:00Z',{profile:autumnProfile}),false);
});
