'use strict';
// Progressive disclosure only: no API requests, storage writes, or farm actions.
// Move existing nodes intact so their IDs, listeners, drafts and status survive.
(() => {
  const get=id=>document.getElementById(id);
  const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=String(text);if(className)element.className=className;return element;};
  function resolve(target){if(typeof target!=='string')return target;try{return get(target)||document.querySelector(target);}catch{return null;}}
  function reveal(target,{focus=false,scroll=false}={}){
    const element=resolve(target);if(!element)return false;
    const parents=[];for(let current=element;current;current=current.parentElement)if(current.tagName==='DETAILS')parents.push(current);
    for(const details of parents.reverse())details.open=true;
    if(scroll)element.scrollIntoView({block:'start',behavior:'instant'});
    if(focus){const destination=element.matches('details')?element.querySelector('summary'):element.matches('button,a,input,select,textarea,summary,[tabindex]')?element:element.querySelector('summary,button,a,input,select,textarea');destination?.focus({preventScroll:true});}
    return true;
  }
  function disclosure(id,title,elements,description=''){
    if(get(id))return get(id);
    const items=elements.filter(Boolean);if(!items.length||!items[0].isConnected)return null;
    const details=node('details',undefined,'focused-disclosure');details.id=id;
    const summary=node('summary'),label=node('span',title,'focused-disclosure-title');summary.append(label);
    if(description)summary.append(node('span',description,'focused-disclosure-description'));
    const body=node('div',undefined,'focused-disclosure-body');body.id=id+'Content';
    items[0].before(details);details.append(summary,body);body.append(...items);return details;
  }
  function jump(label,target){const button=node('button',label,'secondary focused-jump');button.type='button';button.setAttribute('aria-controls',target);button.onclick=()=>reveal(target,{focus:true,scroll:true});return button;}
  function compactNotice(id,parent){const notice=node('p','','focused-notice');notice.id=id;notice.setAttribute('role','status');notice.hidden=true;parent.before(notice);return notice;}
  let queued=false;
  function schedule(){if(!queued){queued=true;queueMicrotask(()=>{queued=false;update();});}}
  function text(id,value){const element=get(id);if(element&&element.textContent!==value)element.textContent=value;}
  function update(){
    const fields=window.FarmerWorkspace?.getFields?.()||[],hasBrief=typeof savedDailyBrief!=='undefined'&&savedDailyBrief&&!savedDailyBrief.deleted;
    text('focusedNextStep',!fields.length?'Start here: add your first field. Then prepare a brief for its weather and your tasks.':!hasBrief?'Next: get today’s brief. You can open a priority to see its sources and choose a task.':'Start with today’s priorities. Open one to understand why it matters, then decide what to do.');
    const empty=get('focusedFieldGuide');if(empty)empty.hidden=fields.length>0;
    const pending=typeof tasks!=='undefined'?tasks.filter(task=>!task.done).length:0;
    text('focusedTasksCount',pending?`${pending} unfinished ${pending===1?'task':'tasks'} · open your saved list`:'No unfinished tasks · use Add task when you need one');
    const weather=document.querySelector('#todayPage .community-context');
    if(weather){
      const state=get('weatherSourceStatus')?.textContent||'',copy=get('weatherCopy')?.textContent||'',temperature=get('currentTemperatureNote')?.textContent||'';
      const unavailable=/no recent forecast|paused|reconnect|could not|unavailable/i.test(state+' '+copy),loading=/connecting|checking|loading/i.test(state+' '+copy),saved=!loading&&/saved|cached/i.test(state),backup=!loading&&(/backup/i.test(state)||get('weatherSourceName')?.textContent==='Open-Meteo');
      const label=unavailable?'Weather unavailable — open for retry and source details':loading?'Checking community weather — not field-specific':saved?'Saved community forecast — check its age before use':backup?'Backup community forecast — not field-specific':'Community forecast — not field-specific';
      text('focusedCommunityLabel',label);
      const warning=get('focusedWeatherNotice');if(warning){warning.hidden=!(unavailable||saved||backup);text('focusedWeatherNotice',unavailable||saved||backup?`${state}. ${copy}${unavailable?'':` ${temperature}`}`:'');}
      // Errors/provenance remain visible even while both forecast panels are shut.
      const tomorrow=get('focusedTomorrow');if(tomorrow){const p=tomorrow.querySelector('.focused-disclosure-description'),value=unavailable?'Forecast unavailable':loading?'Checking forecast sources':saved?'Saved forecast — check date':backup?'Backup provider forecast':'Community outlook, not a field sensor';if(p&&p.textContent!==value)p.textContent=value;}
    }
    text('focusedScheduleSummary',get('scheduleDescription')?.textContent||'Choose when to prepare your brief');
    const message=get('messagingSettings');if(message&&!get('focusedMessages')){disclosure('focusedMessages','Messages & WhatsApp',[message],'Verify your own number; approve each channel separately');}
    const error=get('messagingStatus');if(error?.classList.contains('messaging-warning')&&error.textContent.trim())reveal(error);
  }
  const today=get('todayPage'),settings=get('settingsPage');if(!today||!settings)return;
  document.body.classList.add('focused-views');

  // Daily brief, advisories, source credit, coverage and all alert/expiry text stay exposed.
  const tools=today.querySelector('.phase-home-tools');if(tools){
    const intro=tools.querySelector('p');if(intro){intro.id='focusedNextStep';intro.classList.add('focused-next-step');}
    tools.setAttribute('aria-label','Your next step');
  }
  const work=today.querySelector('.tasks-panel'),taskList=get('taskList');if(work&&taskList){const details=disclosure('focusedTodayTasks','Your saved tasks',[taskList]);const count=node('span','','focused-disclosure-description');count.id='focusedTasksCount';details.querySelector('summary').append(count);}
  const tomorrow=today.querySelector('.tomorrow-card');if(tomorrow)disclosure('focusedTomorrow','Tomorrow’s community forecast',[tomorrow],'Community outlook, not a field sensor');
  const community=today.querySelector('.community-context');if(community){const summary=community.querySelector('summary');summary.id='focusedCommunityLabel';compactNotice('focusedWeatherNotice',community);}

  // Keep the real map and editor untouched; make the first useful step explicit.
  const fieldToolbar=document.querySelector('#fieldsPage .workspace-toolbar');if(fieldToolbar){const guide=node('p','Add your first field: name it, choose its crop, mark a point or draw its boundary, then review and save.','focused-next-step');guide.id='focusedFieldGuide';fieldToolbar.before(guide);}
  const observations=document.querySelector('#fieldsPage .notebook-section');if(observations)disclosure('focusedObservations','Field observations and notes',[observations],'Optional: review saved observations or search your notes');

  const settingsIntro=node('section',undefined,'focused-settings-guide');settingsIntro.id='focusedSettingsGuide';settingsIntro.setAttribute('aria-label','Choose a setting');settingsIntro.append(node('p','What would you like to change? Open one section below.','focused-next-step'));
  const shortcuts=node('div',undefined,'focused-jumps');shortcuts.append(jump('Reading helper','readingHelperPanel'),jump('Listening voice','focusedVoice'),jump('Appearance','focusedAppearance'),jump('Farm profile','focusedProfile'),jump('Daily timing','focusedSchedule'),jump('Messages','focusedMessages'),jump('Plan & access','focusedPlan'));settingsIntro.append(shortcuts);settings.querySelector('.placeholder-head').after(settingsIntro);
  const reading=get('readingHelperPanel');if(reading){const preview=reading.querySelector('.reading-helper-preview'),notes=[...reading.querySelectorAll('.reading-helper-note')];if(preview)disclosure('focusedReadingHelp','Reading preview and help',[preview,...notes]);}
  const profile=get('profileSummary')?.parentElement,appearance=get('themeGrid')?.parentElement;
  if(profile)disclosure('focusedProfile','Farm profile',[profile],'Name, crops, language and farm preferences');
  if(appearance)disclosure('focusedAppearance','Appearance',[appearance],'Choose from ten readable themes');
  const schedulePanel=settings.querySelector('.schedule-panel');if(schedulePanel){const group=disclosure('focusedSchedule','Daily brief timing',[schedulePanel]);const note=node('span','','focused-disclosure-description');note.id='focusedScheduleSummary';group.querySelector('summary').append(note);}
  if(get('planPanel'))disclosure('focusedPlan','Plan & access',[get('planPanel')],'Farmer Daily is free; request Frontier Farm approval');
  const voice=node('div');voice.id='briefVoiceSettings';reading.after(voice);const voiceGroup=disclosure('focusedVoice','Listening voice',[voice],'Optional voices and playback preferences');voiceGroup.querySelector('.focused-disclosure-body').id='focusedVoiceContent';
  // Keep this harmless placeholder hidden until the voice module mounts actual controls.
  voiceGroup.hidden=true;
  new MutationObserver(()=>{voiceGroup.hidden=!get('briefVoiceSettings')?.childElementCount;}).observe(get('focusedVoiceContent'),{childList:true,subtree:true});
  if(!get('briefVoicePlayer')){const player=node('div');player.id='briefVoicePlayer';get('dailyBriefPanel').append(player);}

  const intelligence=get('intelligenceRows');if(intelligence){const heading=intelligence.previousElementSibling?.previousElementSibling,description=intelligence.previousElementSibling;if(heading?.tagName==='H2'&&description?.tagName==='P')disclosure('focusedRoadmap','Build progress and future features',[heading,description,intelligence,get('devStatusLink')],'Development status, not a claim that every source is connected');}
  // All warnings, consent and source permissions stay in their original data panels.
  window.FarmerFocusedViews={reveal,refresh:update};
  // Native summary activation owns its toggle. Opening it during focusin would
  // make the following click immediately close it again.
  document.addEventListener('focusin',event=>{if(event.target.tagName!=='SUMMARY'&&event.target.closest('.focused-disclosure'))reveal(event.target);});
  for(const id of ['fieldGrid','taskList','dailyBriefPanel','weatherSignal','settingsPage'])if(get(id))new MutationObserver(schedule).observe(get(id),{childList:true,subtree:true,characterData:true});
  window.addEventListener('field-data-updated',schedule);window.addEventListener('focus',schedule);update();window.mountBriefVoiceUi?.();
})();
