const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, buildSpokenBrief, rankVoices, chunkText, voiceId, PREFERENCE_KEY } = require('../brief-voice');

const timestamp = Date.parse('2026-10-25T15:00:00Z');
const local = { name: 'Device English Natural', voiceURI: 'device-en', lang: 'en-US', localService: true };
const spanish = { name: 'Device Spanish', voiceURI: 'device-es', lang: 'es-US', localService: true };
const remote = { name: 'Online English Neural', voiceURI: 'remote-en', lang: 'en-US', localService: false };
const brief = () => ({ createdAt: new Date(timestamp).toISOString(), summary: 'Saved source summary.', items: ['Block 12 may reach 31°F.'], coverage: { notices: ['Block 7 not checked.'] }, advisories: [{ fieldName: 'Block 12', title: 'Frost possibility', whatChanged: 'Temperature may reach 31°F. Wind could reach 15.5 mph; rain probability 20%.', suggestedAction: 'Check your local thermometer before acting.', confidence: 'Medium; field conditions may differ', validUntil: new Date(timestamp + 3600000).toISOString(), sources: [{ name: 'NOAA / National Weather Service', url: 'https://www.weather.gov/' }] }] });
function fixture(initialVoices = [local, spanish, remote]) {
  let available = [...initialVoices], owner = 'owner-a', timerId = 0, clock = timestamp;
  const spoken = [], timers = new Map(), stored = new Map(), events = {}, pageEvents = {}, docEvents = {};
  const synth = { cancels: 0, pauses: 0, resumes: 0, getVoices: () => available, cancel() { this.cancels++; }, pause() { this.pauses++; }, resume() { this.resumes++; }, speak(value) { spoken.push(value); }, addEventListener(name, callback) { events[name] = callback; } };
  const doc = { hidden: false, addEventListener(name, callback) { docEvents[name] = callback; } };
  const controller = createController({ window: { addEventListener(name, callback) { pageEvents[name] = callback; } }, document: doc, synth, Utterance: class { constructor(text) { this.text = text; } }, now: () => clock, storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); } });
  controller.configure({ getOwner: () => owner, getLanguage: () => 'en-US' });
  controller.setContext({ owner, briefKey: 'v1', page: 'today' });
  return { controller, spoken, synth, stored, doc, events, docEvents, pageEvents, setNow(value) { clock = value; }, setOwner(value) { owner = value; }, setVoices(value) { available = value; }, play: () => controller.playBrief(brief(), { owner: 'owner-a', briefKey: 'v1', language: 'en-US' }), tick() { const [id, callback] = timers.entries().next().value || []; if (callback) { timers.delete(id); callback(); } }, finish() { let max = 100; while (controller.getState().status === 'playing' && max--) { spoken.at(-1)?.onend?.(); const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); } assert.ok(max > 0); } };
}

test('spoken brief preserves uncertainty, values, date, coverage and public source attribution', () => {
  const result = buildSpokenBrief(brief(), { now: timestamp });
  for (const phrase of ['Saved brief', 'Block 12', 'may reach 31 degrees Fahrenheit', '15.5 miles per hour', '20 percent', 'Medium; field conditions may differ', 'coverage may be missing', 'NOAA / National Weather Service']) assert.ok(result.includes(phrase), phrase);
  assert.doesNotMatch(result, /undefined|null|gpt|AI draft/);
});
test('malformed expiry, old dates and fallback license are spoken, not silently current', () => {
  const data = brief(); data.advisories[0].validUntil = 'unknown'; data.createdAt = '2026-10-01T12:00:00Z'; data.advisories[0].sources = [{ name: 'Open-Meteo', url: 'https://open-meteo.com/' }];
  const result = buildSpokenBrief(data, { now: timestamp });
  assert.match(result, /unknown expiry/); assert.match(result, /out of date/); assert.match(result, /Open-Meteo fallback weather, Creative Commons Attribution 4.0/);
  data.createdAt = 'broken'; assert.match(buildSpokenBrief(data), /saved date is unavailable/);
});
test('spoken source brief keeps safety qualifiers and legacy weather attribution', () => {
  const data = brief(); data.advisories[0].whyItMatters = 'This planning threshold is not a safety or legal limit. Satellite context cannot diagnose disease.';
  const result = buildSpokenBrief(data, { now: timestamp });
  assert.match(result, /not a safety or legal limit/); assert.match(result, /cannot diagnose disease/); assert.match(result, /Block 7 not checked/);
  assert.match(buildSpokenBrief({ items: ['Legacy weather'], weather: { source: { name: 'Open-Meteo' } } }), /Open-Meteo fallback weather, Creative Commons Attribution 4.0/);
});
test('Spanish voice summary preserves written values and warns about unknown expiry', () => {
  const data = brief(); data.advisories[0].validUntil = undefined;
  const result = buildSpokenBrief(data, { language: 'Español', now: timestamp });
  assert.match(result, /Resumen guardado/); assert.match(result, /vencieron/); assert.match(result, /31 grados Fahrenheit/); assert.match(result, /15\.5 millas por hora/);
});
test('legacy brief uses saved words, not invented advice; oversized data fails safely', () => {
  assert.match(buildSpokenBrief({ createdAt: 'invalid', summary: 'Written summary', items: ['Recorded task'] }), /Written summary[\s\S]*Recorded task/);
  assert.throws(() => buildSpokenBrief({ items: ['x'.repeat(12001)] }), /too long/);
  assert.throws(() => buildSpokenBrief({ deleted: true }), /No saved brief/);
});
test('voice ranking prefers local before remote natural names and keeps language separate', () => {
  const plain = { ...local, name: 'Plain device', voiceURI: 'plain' };
  assert.equal(rankVoices([remote, plain, local, spanish], 'English')[0], local);
  assert.deepEqual(rankVoices([local, spanish, remote], 'Español'), [spanish]);
});
test('chunking keeps all text and decimal values; no missing final words', () => {
  const input = Array.from({ length: 20 }, () => 'Field could reach -2.5 degrees Celsius, not a field measurement.').join(' ');
  const pieces = chunkText(input); assert.ok(pieces.length > 1); assert.ok(pieces.every(part => part.length <= 260)); assert.equal(pieces.join(' '), input);
});
test('local voice is explicitly assigned, speech finishes and releases private content', () => {
  const f = fixture(); assert.equal(f.spoken.length, 0); assert.equal(f.play().ok, true); assert.equal(f.spoken[0].voice, local); assert.equal(f.spoken[0].rate, 1);
  f.finish(); assert.equal(f.controller.getState().status, 'idle'); assert.match(f.spoken.map(value => value.text).join(' '), /Block 12/);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /Block 12/); assert.equal(f.stored.size, 0);
});
test('saved brief language wins over a later preference change; playback does not pretend to translate', () => {
  const f = fixture(); const data = brief(); data.language = 'es';
  assert.equal(f.controller.playBrief(data, { owner: 'owner-a', briefKey: 'v1', language: 'English' }).ok, true);
  assert.equal(f.spoken[0].lang, 'es-US'); assert.equal(f.spoken[0].voice, spanish);
});
test('no available voices fails closed, asynchronous voices do not auto-play', () => {
  const f = fixture([]); assert.equal(f.play().ok, false); assert.equal(f.spoken.length, 0);
  f.setVoices([local]); f.events.voiceschanged(); assert.equal(f.spoken.length, 0); assert.equal(f.play().ok, true);
});
test('online and unknown voices require explicit session consent and never silently substitute', () => {
  for (const voice of [remote, { ...remote, localService: undefined }]) {
    const f = fixture([voice]); assert.equal(f.play().ok, false); assert.equal(f.spoken.length, 0);
    f.controller.setOnlineConsent(true); assert.equal(f.play().ok, true); assert.equal(f.spoken[0].voice, voice);
    f.controller.clear(); assert.equal(f.controller.getState().onlineConsent, false); assert.equal(f.play().ok, false);
  }
  const f = fixture(); f.controller.setVoice(voiceId(remote)); assert.equal(f.play().ok, false); assert.equal(f.spoken.length, 0);
  f.controller.setOnlineConsent(true); assert.equal(f.play().ok, true); f.controller.setOnlineConsent(false); assert.equal(f.controller.getState().status, 'idle');
});
test('pause/resume/stop cancel stale callbacks and do not replay canceled text', () => {
  const f = fixture(); f.play(); const late = f.spoken[0].onend;
  f.controller.pause(); assert.equal(f.controller.getState().status, 'paused'); assert.equal(f.synth.pauses, 1);
  f.controller.resume(); assert.equal(f.synth.resumes, 1);
  f.controller.stop(); late(); f.tick(); assert.equal(f.spoken.length, 1); assert.equal(f.controller.getState().status, 'idle');
});
test('pause between chunks resumes at the next chunk only', () => {
  const f = fixture(); f.play(); f.spoken[0].onend(); f.controller.pause(); f.tick(); assert.equal(f.spoken.length, 1);
  f.controller.resume(); assert.equal(f.spoken.length, 2); assert.match(f.spoken[1].text, /Saved brief/);
});
test('resuming or starting another chunk after expiry requires updated narration', () => {
  for (const resume of [true, false]) {
    const f = fixture(); f.play(); if (resume) f.controller.pause(); f.setNow(timestamp + 3600001);
    if (resume) f.controller.resume(); else { f.spoken[0].onend(); f.tick(); }
    assert.equal(f.synth.resumes, 0); assert.equal(f.spoken.length, 1); assert.equal(f.controller.getState().status, 'error'); assert.match(f.controller.getState().message, /freshness/);
    f.play(); f.finish(); assert.match(f.spoken.slice(1).map(value => value.text).join(' '), /expired/);
  }
});
test('owner is checked before playback and again before every chunk', () => {
  const f = fixture(); f.setOwner(null); assert.equal(f.play().ok, false); assert.equal(f.spoken.length, 0);
  f.setOwner('owner-a'); f.play(); f.setOwner('owner-b'); f.spoken[0].onend(); f.tick(); assert.equal(f.spoken.length, 1); assert.equal(f.controller.getState().status, 'idle');
});
test('brief and page changes cancel; owner changes also clear online consent', () => {
  for (const next of [{ briefKey: 'v2' }, { page: 'fields' }, { owner: 'owner-b' }]) {
    const f = fixture(); f.controller.setOnlineConsent(true); f.play(); f.controller.setContext(next); assert.equal(f.controller.getState().status, 'idle');
    if (next.owner) assert.equal(f.controller.getState().onlineConsent, false);
  }
  const f = fixture(); assert.equal(f.controller.playBrief(brief(), { owner: 'owner-a', briefKey: 'different' }).ok, false);
});
test('page hide, tab hide and owner storage change cancel queued speech', () => {
  for (const event of ['pagehide', 'hidden', 'storage']) {
    const f = fixture(); f.play(); const late = f.spoken[0].onend;
    if (event === 'pagehide') f.pageEvents.pagehide();
    else if (event === 'hidden') { f.doc.hidden = true; f.docEvents.visibilitychange(); }
    else f.pageEvents.storage({ key: 'farmerDailyCloudOwner' });
    late(); f.tick(); assert.equal(f.spoken.length, 1); assert.equal(f.controller.getState().status, 'idle');
  }
});
test('voice error and removed voice fail without automatic remote fallback', () => {
  const f = fixture(); f.play(); f.spoken[0].onerror({ error: 'network' }); assert.equal(f.controller.getState().status, 'error'); assert.equal(f.spoken.length, 1);
  f.play(); f.setVoices([remote]); f.events.voiceschanged(); assert.equal(f.controller.getState().status, 'idle'); assert.equal(f.play().ok, false);
});
test('voice becoming online under the same URI stops active on-device speech', () => {
  const f = fixture(); f.play(); f.setVoices([{ ...local, localService: false }]); f.events.voiceschanged(); assert.equal(f.controller.getState().status, 'idle'); assert.equal(f.play().ok, false);
});
test('only generic device preferences persist; preview never reads private brief', () => {
  const f = fixture(); f.play(); f.controller.setRate(.9); f.controller.setVoice(voiceId(local)); f.controller.setOnlineConsent(true);
  const saved = f.stored.get(PREFERENCE_KEY); assert.match(saved, /0.9/); assert.doesNotMatch(saved, /Block 12|owner-a|onlineConsent|saved brief/);
  f.setOwner(null); assert.equal(f.controller.previewVoice().ok, true); assert.equal(f.spoken.at(-1).text, 'Welcome to Farmer Daily. This is a voice sample. Choose a pace that feels comfortable.'); assert.equal(f.spoken.at(-1).rate, .9);
});
test('unsupported browser and broken preference storage remain safe', () => {
  const controller = createController({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(controller.getState().supported, false); controller.setRate(1.1); assert.equal(controller.previewVoice().ok, false);
});
