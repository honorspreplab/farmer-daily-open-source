/* Free browser speech. No app TTS endpoint, audio upload, or persisted farm text. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmerBriefVoice = factory().createController({ window: root });
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const PREFERENCE_KEY = 'farmerDailyDeviceVoiceV1';
  const languageOf = value => /español|spanish|^es(?:-|$)/i.test(String(value || '')) ? 'es-US' : 'en-US';
  const voiceId = voice => `${voice.lang || ''}|${voice.voiceURI || voice.name || ''}`;
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const say = (language, en, es) => languageOf(language) === 'es-US' ? es : en;

  function rankVoices(voices, language) {
    const prefix = languageOf(language).slice(0, 2);
    return Array.from(voices || []).filter(voice => String(voice.lang || '').toLowerCase().startsWith(prefix))
      .sort((a, b) => {
        const score = voice => (voice.localService === true ? 100 : 0)
          + (/natural|neural|enhanced|premium/i.test(voice.name || '') ? 10 : 0)
          + (voice.default ? 2 : 0) + (voice.lang === languageOf(language) ? 1 : 0);
        return score(b) - score(a) || String(a.name).localeCompare(String(b.name));
      });
  }

  function spokenUnits(text, language) {
    const spanish = languageOf(language) === 'es-US';
    return text.replace(/°\s*F\b/gi, spanish ? ' grados Fahrenheit' : ' degrees Fahrenheit')
      .replace(/°\s*C\b/gi, spanish ? ' grados Celsius' : ' degrees Celsius')
      .replace(/\bmph\b/gi, spanish ? 'millas por hora' : 'miles per hour')
      .replace(/(\d)%/g, spanish ? '$1 por ciento' : '$1 percent');
  }

  function buildSpokenBrief(brief, { language = 'en-US', now = Date.now() } = {}) {
    if (!brief || brief.deleted) throw new Error('No saved brief is available.');
    language = languageOf(language);
    const tr = (en, es) => say(language, en, es), paragraphs = [];
    const createdAt = Date.parse(brief.createdAt);
    paragraphs.push(tr('Here is your Farmer Daily brief.', 'Este es su resumen de Farmer Daily.'));
    paragraphs.push(Number.isFinite(createdAt)
      ? tr(`Saved brief from ${new Date(createdAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`,
        `Resumen guardado el ${new Date(createdAt).toLocaleString('es-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`)
      : tr('The saved date is unavailable. Refresh before acting.', 'La fecha del resumen no está disponible. Actualice antes de actuar.'));
    if (Number.isFinite(createdAt) && (now - createdAt > 86400000 || createdAt > now + 300000)) {
      paragraphs.push(tr('This saved brief may be out of date. Refresh before acting.', 'Este resumen guardado puede estar desactualizado. Actualice antes de actuar.'));
    }
    const advisories = Array.isArray(brief.advisories) ? brief.advisories.filter(item => item && typeof item === 'object') : [];
    if (advisories.some(item => !Number.isFinite(Date.parse(item.validUntil)) || Date.parse(item.validUntil) <= now)) {
      paragraphs.push(tr('Some advisories have expired or have an unknown expiry. Refresh before acting.', 'Algunos avisos vencieron o no tienen fecha de vencimiento conocida. Actualice antes de actuar.'));
    }
    if ((brief.coverage?.notices || []).length || brief.coverage?.complete === false || brief.coverage?.partial === true) {
      paragraphs.push(tr('Some field data or coverage may be missing. Check the coverage notes in your written brief.', 'Pueden faltar datos o cobertura de algunas parcelas. Revise las notas de cobertura del resumen escrito.'));
      for (const notice of (Array.isArray(brief.coverage?.notices) ? brief.coverage.notices : []).slice(0, 3)) if (clean(notice)) paragraphs.push(clean(notice));
    }
    if (advisories.length) {
      for (const [index, advisory] of advisories.slice(0, 3).entries()) {
        const name = [clean(advisory.fieldName), clean(advisory.title)].filter(Boolean).join('. ');
        const pieces = [tr(`Priority ${index + 1}. ${name}.`, `Prioridad ${index + 1}. ${name}.`), clean(advisory.whatChanged)];
        // Safety qualifiers often live here; never shorten them into a stronger claim.
        if (clean(advisory.whyItMatters)) pieces.push(clean(advisory.whyItMatters));
        if (clean(advisory.suggestedAction)) pieces.push(tr('A next step to consider: ', 'Un posible siguiente paso: ') + clean(advisory.suggestedAction));
        if (clean(advisory.confidence)) pieces.push(tr('Confidence: ', 'Confianza: ') + clean(advisory.confidence) + '.');
        paragraphs.push(pieces.filter(Boolean).join(' '));
      }
    } else {
      if (clean(brief.summary)) paragraphs.push(clean(brief.summary));
      for (const [index, item] of (Array.isArray(brief.items) ? brief.items : []).slice(0, 3).entries()) {
        if (clean(item)) paragraphs.push(`${index + 1}. ${clean(item)}`);
      }
    }
    const sources = advisories.flatMap(item => Array.isArray(item.sources) ? item.sources : []);
    const sourceText = JSON.stringify([brief.source || '', brief.weather?.source || '', ...sources.map(source => [source?.name, source?.url, source?.id])]);
    const names = [];
    if (/weather\.gov|\bnws\b|national weather|noaa/i.test(sourceText)) names.push('NOAA / National Weather Service');
    if (/open-meteo/i.test(sourceText)) names.push(tr('Open-Meteo fallback weather, Creative Commons Attribution 4.0; wording and units adapted', 'pronóstico alternativo de Open-Meteo, Creative Commons Atribución 4.0; texto y unidades adaptados'));
    if (/usgs|3dep/i.test(sourceText)) names.push('USGS');
    if (/nasa|landsat/i.test(sourceText)) names.push('NASA / USGS Landsat');
    if (/sentinel|copernicus/i.test(sourceText)) names.push('Copernicus Sentinel');
    if (/usda|nrcs|nass/i.test(sourceText)) names.push('USDA');
    if (names.length) paragraphs.push(tr('Sources: ', 'Fuentes: ') + [...new Set(names)].join('; ') + '.');
    paragraphs.push(tr('Check the written brief for source dates and full details.', 'Consulte el resumen escrito para ver las fechas de las fuentes y todos los detalles.'));
    const result = paragraphs.map(part => spokenUnits(part, language)).join('\n\n');
    if (result.length > 12000) throw new Error('This brief is too long for voice playback. Please use the written brief.');
    return result;
  }

  function chunkText(text, limit = 260) {
    const chunks = [];
    for (const paragraph of String(text).split(/\n+/).filter(Boolean)) {
      let remaining = paragraph.trim();
      while (remaining.length > limit) {
        const part = remaining.slice(0, limit + 1);
        const sentence = [...part.matchAll(/[.!?](?=\s)/g)].at(-1);
        const end = sentence && sentence.index > limit / 3 ? sentence.index + 1 : part.lastIndexOf(' ');
        const split = end > 0 ? end : limit;
        chunks.push(remaining.slice(0, split).trim()); remaining = remaining.slice(split).trim();
      }
      if (remaining) chunks.push(remaining);
    }
    return chunks;
  }

  function createController(options = {}) {
    const win = options.window || {}, doc = options.document || win.document;
    const synth = options.synth || win.speechSynthesis, Utterance = options.Utterance || win.SpeechSynthesisUtterance;
    const later = options.setTimeout || win.setTimeout?.bind(win) || setTimeout;
    const cancelLater = options.clearTimeout || win.clearTimeout?.bind(win) || clearTimeout;
    const now = options.now || Date.now;
    let storage = options.storage;
    if (!storage) { try { storage = win.localStorage; } catch { /* Private browsing can disable storage. */ } }
    let preferences = { rate: 1, voices: {}, language: 'en-US' };
    try {
      const saved = JSON.parse(storage?.getItem(PREFERENCE_KEY) || 'null');
      if (saved && Number.isFinite(saved.rate) && saved.rate >= .8 && saved.rate <= 1.2) preferences.rate = saved.rate;
      for (const language of ['en-US', 'es-US']) if (typeof saved?.voices?.[language] === 'string') preferences.voices[language] = saved.voices[language].slice(0, 300);
      if (saved) preferences.language = languageOf(saved.language);
    } catch { /* Keep usable defaults when a saved preference is malformed. */ }
    let getOwner = () => null, getLanguage = () => 'en-US', onlineConsent = false;
    let context = {}, state = 'idle', message = '', epoch = 0, timer = null, chunks = [], index = 0, active = null;
    let speechOwner = null, speechLanguage = 'en-US', selectedVoice = null, preview = false, freshnessDeadline = Infinity;
    const views = new Set();
    const tr = (en, es) => say(getLanguage(), en, es);
    function voices() { try { return Array.from(synth?.getVoices?.() || []); } catch { return []; } }
    function persist() { try { storage?.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* Voice still works without persistence. */ } }
    function currentOwner() { try { return getOwner() || null; } catch { return null; } }
    function getState() { return { status: state, message, rate: preferences.rate, language: preferences.language, onlineConsent, supported: !!(synth && Utterance), isPreview: preview, voiceName: selectedVoice?.name || '' }; }
    function notify() { for (const render of views) render(); }
    function discard() {
      epoch++; if (timer !== null) cancelLater(timer); timer = null;
      if (active) { active.onend = null; active.onerror = null; }
      active = null; chunks = []; index = 0; speechOwner = null; selectedVoice = null; preview = false; freshnessDeadline = Infinity;
      try { synth?.cancel(); } catch { /* Cancellation must not block privacy cleanup. */ }
    }
    function stop() { discard(); state = 'idle'; message = ''; notify(); }
    function fail(reason) { discard(); state = 'error'; message = reason; notify(); return { ok: false, reason }; }
    function clear() { discard(); onlineConsent = false; context = {}; state = 'idle'; message = ''; notify(); }
    function resolveVoice(language) {
      const matching = rankVoices(voices(), language), preferred = preferences.voices[languageOf(language)];
      // An unavailable explicit choice is not silently replaced by an online/default voice.
      if (preferred) return matching.find(voice => voiceId(voice) === preferred) || null;
      return matching.find(voice => voice.localService === true) || (onlineConsent ? matching[0] : null);
    }
    function authorized() { return preview || (!!speechOwner && currentOwner() === speechOwner && (!context.owner || context.owner === speechOwner)); }
    function stillFresh() {
      if (preview || now() < freshnessDeadline) return true;
      fail(tr('The saved brief reached a freshness limit while listening. Refresh it, or start again to hear the updated warning.', 'El resumen alcanzó un límite de vigencia durante la lectura. Actualícelo o inicie de nuevo para escuchar la advertencia actualizada.'));
      return false;
    }
    function speakNext(run) {
      timer = null;
      if (run !== epoch || state !== 'playing') return;
      if (!authorized()) { clear(); return; }
      if (!stillFresh()) return;
      const liveVoice = voices().find(voice => voiceId(voice) === voiceId(selectedVoice || {}));
      if (!liveVoice || (liveVoice.localService !== true && !onlineConsent)) { fail(tr('Your selected voice is no longer available. Choose a voice in Settings.', 'La voz elegida ya no está disponible. Elija una voz en Configuración.')); return; }
      if (index >= chunks.length) { stop(); return; }
      const utterance = new Utterance(chunks[index]); active = utterance;
      utterance.voice = liveVoice; utterance.lang = liveVoice.lang || speechLanguage;
      utterance.rate = preferences.rate; utterance.pitch = 1; utterance.volume = 1;
      utterance.onend = () => {
        if (run !== epoch) return;
        active = null; index++;
        if (state === 'playing') timer = later(() => speakNext(run), 100);
      };
      utterance.onerror = () => { if (run === epoch) fail(tr('Voice playback stopped. Try another device voice in Settings.', 'La lectura se detuvo. Pruebe otra voz del dispositivo en Configuración.')); };
      try { synth.speak(utterance); } catch { fail(tr('Voice playback could not start. Try another voice in Settings.', 'No se pudo iniciar la lectura. Pruebe otra voz en Configuración.')); }
    }
    function start(text, { owner, language, isPreview = false, deadline = Infinity } = {}) {
      if (!synth || !Utterance) return fail(tr('Voice playback is unavailable in this browser.', 'La lectura en voz alta no está disponible en este navegador.'));
      if (!isPreview && (!owner || owner !== currentOwner() || (context.owner && context.owner !== owner))) return fail(tr('Sign in again before listening to your saved brief.', 'Inicie sesión de nuevo antes de escuchar su resumen guardado.'));
      language = languageOf(language); const voice = resolveVoice(language);
      if (!voice) return fail(tr('Choose an available device voice in Settings. Voices may still be loading; online voices need your permission.', 'Elija una voz disponible en Configuración. Las voces pueden estar cargando; las voces en línea necesitan su permiso.'));
      if (voice.localService !== true && !onlineConsent) return fail(tr('This voice uses an online or unknown service. Give permission in Voice settings first, or choose an on-device voice.', 'Esta voz usa un servicio en línea o desconocido. Dé permiso en Configuración de voz o elija una voz del dispositivo.'));
      discard(); speechOwner = owner || null; speechLanguage = language; selectedVoice = voice; preview = isPreview; freshnessDeadline = deadline;
      chunks = chunkText(text); state = 'playing'; message = isPreview ? tr('Playing a public voice sample.', 'Reproduciendo una muestra pública.') : tr('Reading your saved brief.', 'Leyendo su resumen guardado.');
      notify(); speakNext(epoch); return { ok: state !== 'error', reason: state === 'error' ? message : '' };
    }
    function playBrief(brief, settings = {}) {
      if (settings.briefKey !== undefined && context.briefKey !== undefined && settings.briefKey !== context.briefKey) return fail(tr('Your brief changed. Start listening again.', 'Su resumen cambió. Inicie la lectura de nuevo.'));
      // Reading must follow the saved text, not pretend a changed preference translated it.
      const language = brief?.language || settings.language || getLanguage();
      const current = now(), dates = [Date.parse(brief?.createdAt) + 86400000, ...(Array.isArray(brief?.advisories) ? brief.advisories : []).map(item => Date.parse(item?.validUntil))];
      const deadline = Math.min(Infinity, ...dates.filter(value => Number.isFinite(value) && value > current));
      try { return start(buildSpokenBrief(brief, { language, now: current }), { ...settings, language, deadline }); }
      catch { return fail(tr('This saved brief cannot be read. Refresh it, or use the written version.', 'No se puede leer este resumen. Actualícelo o use la versión escrita.')); }
    }
    function pause() {
      if (state !== 'playing') return;
      if (!authorized()) { clear(); return; }
      state = 'paused'; if (timer !== null) { cancelLater(timer); timer = null; }
      try { if (active) synth.pause(); } catch { stop(); }
      notify();
    }
    function resume() {
      if (state !== 'paused') return;
      if (!authorized()) { clear(); return; }
      if (!stillFresh()) return;
      state = 'playing';
      try { if (active) synth.resume(); else speakNext(epoch); } catch { stop(); }
      notify();
    }
    function setContext(next = {}) {
      const changed = ['owner', 'briefKey', 'page'].some(key => Object.hasOwn(next, key) && context[key] !== next[key]);
      const ownerChanged = Object.hasOwn(next, 'owner') && context.owner !== next.owner;
      if (changed) stop(); if (ownerChanged) onlineConsent = false;
      context = { ...context, ...next }; notify();
    }
    function setVoice(id, language = preferences.language) { stop(); preferences.voices[languageOf(language)] = String(id || '').slice(0, 300); persist(); notify(); }
    function setRate(rate) { if (!Number.isFinite(Number(rate))) return; stop(); preferences.rate = Math.max(.8, Math.min(1.2, Math.round(Number(rate) * 20) / 20)); persist(); notify(); }
    function setOnlineConsent(allowed) { stop(); onlineConsent = allowed === true; notify(); }
    function previewVoice() { const language = preferences.language; return start(say(language, 'Welcome to Farmer Daily. This is a voice sample. Choose a pace that feels comfortable.', 'Bienvenido a Farmer Daily. Esta es una muestra de voz. Elija un ritmo cómodo.'), { language, isPreview: true }); }
    function node(tag, text, className) { const item = doc.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
    function button(label, action) { const result = node('button', label, 'secondary'); result.type = 'button'; result.addEventListener('click', action); return result; }
    function mountSettings(parent) {
      if (!parent || !doc || parent.dataset.briefVoiceMounted) return; parent.dataset.briefVoiceMounted = 'true'; parent.classList.add('brief-voice-settings');
      const title = node('h3', tr('A voice that suits you', 'Una voz a su gusto'));
      const description = node('p', tr('Free device voices vary by browser. Try a voice and a comfortable pace. The brief keeps your farm’s language; this does not translate it.', 'Las voces gratuitas varían según el navegador. Pruebe una voz y un ritmo cómodo. El resumen mantiene el idioma de su finca; esto no lo traduce.'));
      const languageLabel = node('label', tr('Voice language', 'Idioma de la voz')), language = node('select'); language.id = 'briefVoiceLanguage'; languageLabel.htmlFor = language.id;
      for (const [value, text] of [['en-US', 'English'], ['es-US', 'Español']]) { const item = node('option', text); item.value = value; language.append(item); }
      const voiceLabel = node('label', tr('Voice', 'Voz')), picker = node('select'); picker.id = 'briefVoiceChoice'; voiceLabel.htmlFor = picker.id;
      const rateLabel = node('label', tr('Speaking pace', 'Velocidad')), rate = node('input'), rateValue = node('output'); rate.id = 'briefVoiceRate'; rateLabel.htmlFor = rate.id; rate.type = 'range'; rate.min = '.8'; rate.max = '1.2'; rate.step = '.05';
      const onlineLabel = node('label', undefined, 'brief-voice-consent'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'briefVoiceOnlineConsent';
      onlineLabel.append(checkbox, node('span', tr('Allow online voices for this signed-in session. My browser’s voice provider may receive the text spoken aloud, including my brief. Unmarked voices are treated as online. Permission resets on account change.', 'Permitir voces en línea durante esta sesión. El proveedor de voz del navegador puede recibir el texto leído, incluido mi resumen. Las voces sin indicación se consideran en línea. El permiso se reinicia al cambiar de cuenta.')));
      const help = node('p', '', 'brief-voice-note'), feedback = node('p', '', 'brief-voice-note'); feedback.setAttribute('role', 'status');
      const actions = node('div', undefined, 'brief-voice-actions'); actions.append(button(tr('Try voice sample', 'Probar muestra'), previewVoice), button(tr('Stop', 'Detener'), stop));
      parent.replaceChildren(title, description, languageLabel, language, voiceLabel, picker, rateLabel, rate, rateValue, onlineLabel, help, actions, feedback);
      language.addEventListener('change', () => { stop(); preferences.language = languageOf(language.value); persist(); notify(); });
      picker.addEventListener('change', () => setVoice(picker.value)); rate.addEventListener('input', () => setRate(rate.value)); checkbox.addEventListener('change', () => setOnlineConsent(checkbox.checked));
      const render = () => {
        language.value = preferences.language; picker.replaceChildren();
        const automatic = node('option', tr('Recommended voice — on-device first', 'Voz recomendada — dispositivo primero')); automatic.value = ''; picker.append(automatic);
        const list = rankVoices(voices(), preferences.language);
        for (const voice of list) { const option = node('option', `${voice.name} — ${voice.lang} · ${voice.localService === true ? tr('on device', 'en el dispositivo') : tr('online / unknown', 'en línea / desconocida')}`); option.value = voiceId(voice); picker.append(option); }
        const chosen = preferences.voices[preferences.language] || '';
        if (chosen && !list.some(voice => voiceId(voice) === chosen)) { const missing = node('option', tr('Saved voice unavailable — choose another', 'Voz guardada no disponible — elija otra')); missing.value = chosen; picker.append(missing); }
        picker.value = chosen; rate.value = String(preferences.rate); rateValue.textContent = `${preferences.rate.toFixed(2)}×`; rate.setAttribute('aria-valuetext', tr(`${preferences.rate.toFixed(2)} times normal speed`, `${preferences.rate.toFixed(2)} veces la velocidad normal`)); checkbox.checked = onlineConsent;
        help.textContent = !synth || !Utterance ? tr('This browser does not support voice playback.', 'Este navegador no admite lectura en voz alta.') : !list.length ? tr('No matching voices are available yet. Voice lists can take a moment to load. You can still read every brief.', 'Aún no hay voces de este idioma. Pueden tardar en cargar. Siempre puede leer el resumen.') : tr('On-device voices are preferred. “Natural” names are a quality hint, not a guarantee. Changing voice or pace stops playback.', 'Se prefieren las voces del dispositivo. “Natural” es una pista de calidad, no una garantía. Cambiar voz o velocidad detiene la lectura.');
        feedback.textContent = message;
      };
      views.add(render); render();
    }
    function mountPlayer(parent) {
      if (!parent || !doc || parent.dataset.briefVoiceMounted) return; parent.dataset.briefVoiceMounted = 'true'; parent.classList.add('brief-voice-player');
      const status = node('p'); status.setAttribute('role', 'status');
      const toggle = button(tr('Pause', 'Pausar'), () => state === 'paused' ? resume() : pause());
      const end = button(tr('Stop', 'Detener'), stop), actions = node('div', undefined, 'brief-voice-actions'); actions.append(toggle, end); parent.replaceChildren(status, actions);
      const render = () => { parent.hidden = state === 'idle'; status.textContent = state === 'paused' ? tr('Paused. Resume when you are ready.', 'En pausa. Continúe cuando esté listo.') : message; toggle.hidden = !['playing', 'paused'].includes(state); toggle.textContent = state === 'paused' ? tr('Resume', 'Continuar') : tr('Pause', 'Pausar'); end.hidden = state === 'error'; };
      views.add(render); render();
    }
    const refreshVoices = () => {
      const current = selectedVoice && voices().find(voice => voiceId(voice) === voiceId(selectedVoice));
      if (selectedVoice && (!current || (current.localService !== true && !onlineConsent))) stop();
      notify();
    };
    synth?.addEventListener?.('voiceschanged', refreshVoices);
    win.addEventListener?.('pagehide', clear);
    win.addEventListener?.('storage', event => { if (event.key === 'farmerDailyCloudOwner') clear(); });
    doc?.addEventListener?.('visibilitychange', () => { if (doc.hidden) stop(); });
    return { configure(value = {}) { if (typeof value.getOwner === 'function') getOwner = value.getOwner; if (typeof value.getLanguage === 'function') getLanguage = value.getLanguage; notify(); }, setContext, playBrief, pause, resume, stop, clear, getState, setVoice, setRate, setOnlineConsent, previewVoice, mountSettings, mountPlayer, refreshVoices };
  }
  return { createController, buildSpokenBrief, chunkText, rankVoices, languageOf, voiceId, spokenUnits, PREFERENCE_KEY };
});
