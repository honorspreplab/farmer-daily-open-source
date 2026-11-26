const defaultTasks=[];
let tasks=JSON.parse(localStorage.getItem('farmerDailyTasks')||'null')||defaultTasks;
const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
let profile=JSON.parse(localStorage.getItem('farmerDailyProfile')||'null');
const roleNames={owner:'Owner',manager:'Farm manager',supervisor:'Crew supervisor',worker:'Field worker',operator:'Equipment operator',irrigation:'Irrigation operator',agronomist:'Agronomist / scout',office:'Office / compliance'};
const waLocations={kirkland:['Kirkland, WA',47.6769,-122.2060,'puget'],seattle:['Seattle, WA',47.6062,-122.3321,'puget'],bellevue:['Bellevue, WA',47.6101,-122.2015,'puget'],snohomish:['Snohomish, WA',47.9129,-122.0982,'puget'],tacoma:['Tacoma, WA',47.2529,-122.4443,'puget'],olympia:['Olympia, WA',47.0379,-122.9007,'puget'],mount_vernon:['Mount Vernon, WA',48.4212,-122.3340,'skagit'],bellingham:['Bellingham, WA',48.7519,-122.4787,'skagit'],sequim:['Sequim, WA',48.0795,-123.1018,'rainshadow'],yakima:['Yakima, WA',46.6021,-120.5059,'yakima'],wenatchee:['Wenatchee, WA',47.4235,-120.3103,'wenatchee'],chelan:['Chelan, WA',47.8409,-120.0165,'wenatchee'],ellensburg:['Ellensburg, WA',46.9965,-120.5478,'foothills'],moses_lake:['Moses Lake, WA',47.1301,-119.2781,'basin'],spokane:['Spokane, WA',47.6588,-117.4260,'foothills'],pullman:['Pullman, WA',46.7298,-117.1817,'palouse'],walla_walla:['Walla Walla, WA',46.0646,-118.3430,'walla'],okanogan:['Okanogan, WA',48.3613,-119.5834,'okanogan'],vancouver:['Vancouver, WA',45.6387,-122.6615,'southwest'],chehalis:['Chehalis, WA',46.6620,-122.9640,'southwest'],goldendale:['Goldendale, WA',45.8207,-120.8217,'gorge']};
const regionData={puget:['Puget Sound lowlands','Rain and leaf-wetness window','Wet-soil access is today’s limiting factor','Drainage · disease · field access'],skagit:['Skagit / Whatcom valleys','Field access improves late morning','Check saturated areas before moving equipment','Flood · wind · soil trafficability'],rainshadow:['Olympic rain shadow','Irrigation check before afternoon wind','Local conditions are drier than western WA averages','Wind · irrigation · marine effects'],southwest:['Southwest Washington','Best harvest window is this morning','Rain and trafficability drive today’s sequence','Rain · forage · drainage'],yakima:['Yakima Valley','Low-wind window ends late morning','Irrigation demand and afternoon heat are rising','Frost · heat · water · smoke'],wenatchee:['Wenatchee / Chelan','Scout the lowest block first','Elevation and cold-air drainage change block risk','Slope · frost · orchard microclimate'],basin:['Columbia Basin','Irrigation is today’s first constraint','High ET and wind increase water demand','ET · wind · heat · dust'],palouse:['Palouse','Scout south-facing slopes first','Slope and aspect are driving field differences','Moisture · slope · harvest timing'],walla:['Walla Walla','Finish exposed work before afternoon heat','Site elevation changes heat accumulation','Heat · frost · crop maturity'],okanogan:['Okanogan','Check valley blocks before upland fields','Temperature swing and smoke risk are elevated','Frost · heat · smoke · irrigation'],gorge:['Columbia Gorge','Low-wind work window is brief','Local wind corridor conditions drive timing','Wind · spray safety · equipment'],foothills:['Foothills / higher elevation','Check access and the coldest field first','Elevation shortens the workable window','Frost · snow · access · season length']};
function applyProfile(){
  refreshWelcome();
  if(!profile)return;
  const field=profile.priorityField||'your priority field',crop=profile.crops?.[0]||'your crop',region=regionData[profile.region]||regionData.yakima;
  const roleCopy={owner:'Your fields, outstanding work, and decisions.',manager:'Your work plan, field records, and priorities.',supervisor:'Prepare assignments and review recorded progress.',worker:'Your saved tasks, field notes, and conditions.',operator:'Review your assignments and equipment checks.',irrigation:'Record field checks; no sensors or equipment controls are connected.',agronomist:'Review field observations and plan your next inspection.',office:'Farm records, planning, and coordination.'};
  $('#welcomeName').textContent=profile.firstName;$('#farmNameSide').textContent=profile.farmName;$('#farmLocationSide').textContent=profile.location;$('#topLocation').textContent=profile.location;
  $('#farmInitials').textContent=profile.farmName.split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();$('.avatar').textContent=profile.firstName.slice(0,1).toUpperCase()+profile.farmName.slice(0,1).toUpperCase();
  $('#priorityTitle').textContent=`Your saved priority: ${field}`;
  $('#priorityCopy').textContent=`You selected ${field} for your ${crop.toLowerCase()} operation in ${region[0]}. Review a weather-aware work plan before creating tasks. This is your preference, not a measured field condition.`;
  $('#askWhyBtn').textContent=`Ask why ${field}`;$('#welcomeSubtitle').textContent=roleCopy[profile.role]||'Your farm records and planned work.';
  $('#weatherSignal h3').textContent='Checking your local weather';$('#weatherCopy').textContent='NOAA/NWS forecast with Open-Meteo backup.';
  $('#operationSignal h3').textContent='Your field records';$('#operationSignal>p').textContent='Add your actual fields and observations in the field notebook.';$('#operationMetric').textContent='Your data';
  $('#safetySignal h3').textContent='Review conditions before working';$('#safetySignal>p').textContent=`Your planning wind threshold is ${profile.wind} mph. Forecasts are not field measurements or safety clearance.`;
  $('#fieldsFarmLabel').textContent=profile.farmName.toUpperCase();$('#sourceSummary').textContent=`${profile.location} · NOAA/NWS with Open-Meteo backup`;
  $('#profileSummary').replaceChildren();
  for(const [label,value] of [['Name',profile.firstName],['Farm',profile.farmName],['Location',profile.location],['Region',region[0]],['Role',roleNames[profile.role]],['Language preference',profile.language||'English'],['Crops',(profile.crops||[]).join(', ')],['Priority area',field],['Planning wind threshold',`${profile.wind} mph`],['Daily brief',profile.briefTime]]){
    const row=document.createElement('div'),name=document.createElement('span'),detail=document.createElement('b');row.className='profile-line';name.textContent=label;detail.textContent=value;row.append(name,detail);$('#profileSummary').append(row);
  }
  window.FarmerWorkspace?.render();
}
function appendContactSummary(){const box=$('#profileSummary');if(!box||!profile)return;[['Address',profile.address||'Not provided'],['Profile phone',profile.phone||'Not provided'],['Daily SMS / WhatsApp','Manage verified delivery in Messages & WhatsApp below'],['Urgent message alerts','Not supported']].forEach(([label,value])=>{const row=document.createElement('div');row.className='profile-line';const name=document.createElement('span'),detail=document.createElement('b');name.textContent=label;detail.textContent=value;row.append(name,detail);box.appendChild(row)})}
const save=()=>{if(!membershipAllowsCore())return;localStorage.setItem('farmerDailyTasks',JSON.stringify(tasks));};
function renderTasks(){
  for(const target of [$('#taskList'),$('#allTaskList')]){
    target.replaceChildren();
    if(!tasks.length){const empty=document.createElement('p');empty.className='workspace-empty';empty.textContent='No tasks yet. Add one or review a work plan.';target.append(empty);}
    for(const task of tasks){
      const row=document.createElement('div'),check=document.createElement('input'),time=document.createElement('span'),info=document.createElement('span'),name=document.createElement('b'),place=document.createElement('small'),status=document.createElement('em');
      row.className=`task-row ${task.done?'done':''}`;row.dataset.id=task.id;check.type='checkbox';check.className='task-check';check.checked=!!task.done;check.setAttribute('aria-label',`Mark ${task.name} complete`);
      time.className='task-time';time.textContent=[task.date,task.time||'Choose time'].filter(Boolean).join(' · ');info.className='task-info';name.textContent=task.name;place.textContent=task.place||profile?.farmName||'Your farm';status.className='status';status.textContent=task.done?'Complete':task.status||'Planned';info.append(name,place);
      const edit=document.createElement('button');edit.type='button';edit.className='text-btn task-edit';edit.textContent='Edit task';edit.onclick=()=>showModal(task);info.append(edit);
      check.onchange=()=>{if(!requireCore())return;task.done=check.checked;task.completedAt=task.done?new Date().toISOString():null;save();renderTasks();window.FarmerWorkspace?.render();saveCloudState();toast(task.done?'Task marked complete':'Task reopened');};
      row.append(check,time,info,status);target.append(row);
    }
  }
  $('#taskCount').textContent=tasks.filter(t=>!t.done).length;
}
renderTasks();
// The Washington farm clock is independent of the device timezone and brief age.
function farmClock(now=Date.now(),language='English'){
  const spanish=/español|spanish|^es(?:-|$)/i.test(language||''),instant=new Date(now);
  if(!Number.isFinite(instant.getTime()))return {greeting:spanish?'Hola':'Hello',dateLabel:spanish?'HORA DEL PACÍFICO':'PACIFIC TIME',period:null};
  const timeZone='America/Los_Angeles',hour=Number(new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',hourCycle:'h23'}).format(instant));
  const period=hour>=5&&hour<12?'morning':hour>=12&&hour<18?'afternoon':'evening';
  const greetings=spanish?{morning:'Buenos días',afternoon:'Buenas tardes',evening:'Buenas noches'}:{morning:'Good morning',afternoon:'Good afternoon',evening:'Good evening'};
  return {greeting:greetings[period],dateLabel:instant.toLocaleDateString(spanish?'es-US':'en-US',{timeZone,weekday:'long',month:'long',day:'numeric'}).toLocaleUpperCase(spanish?'es-US':'en-US'),period};
}
function refreshWelcome(now=Date.now()){
  const clock=farmClock(now,profile?.language);
  const greeting=$('#welcomeGreeting'),name=$('#welcomeName'),dateLabel=$('#dateLabel');
  if(greeting)greeting.textContent=clock.greeting;
  if(name)name.textContent=profile?.firstName||(/español|spanish|^es(?:-|$)/i.test(profile?.language||'')?'agricultor':'farmer');
  if(dateLabel){dateLabel.textContent=clock.dateLabel;dateLabel.title='Farm time: America/Los_Angeles (Pacific)';}
  updateDeliveryUi(now);
}
let welcomeClockTimer=null;
function startWelcomeClock(){
  clearTimeout(welcomeClockTimer);welcomeClockTimer=null;refreshWelcome();
  if(!document.hidden)welcomeClockTimer=setTimeout(startWelcomeClock,60000-(Date.now()%60000)+25);
}
window.addEventListener('focus',startWelcomeClock);
window.addEventListener('pageshow',startWelcomeClock);
document.addEventListener('visibilitychange',startWelcomeClock);
startWelcomeClock();
// Navigation and account changes may refresh this display; neither builds a brief.
function openPage(page,updateHash=true){if(!['today','fields','tasks','jobs','connected','insights','intelligence','settings','security'].includes(page))page='today';if(page==='jobs'&&!membershipAllowsPremium())page='today';const button=$(`.nav-item[data-page="${page}"]`),target=$(`#${page}Page`);if(!button||!target)return;$$('.nav-item').forEach(x=>x.classList.remove('active'));button.classList.add('active');$$('.page').forEach(x=>x.classList.remove('active'));target.classList.add('active');$('.sidebar').classList.remove('open');if(updateHash&&location.hash!==`#${page}`)history.replaceState(null,'',`#${page}`);window.syncBriefVoiceContext?.();if(page==='fields')setTimeout(()=>window.FarmerFieldMap?.render(window.FarmerWorkspace?.getFields()||[]),0);if(page==='connected')window.ConnectedFarm?.open();if(page==='settings')window.FarmerMessaging?.open();window.PhaseOne?.renderProgress();window.FarmerFocusedViews?.refresh();}
$$('.nav-item[data-page]').forEach(b=>b.onclick=()=>openPage(b.dataset.page));
window.addEventListener('hashchange',()=>openPage(location.hash.slice(1)||'today',false));
openPage(location.hash.slice(1)||'today',false);
$('#menuBtn').onclick=()=>$('.sidebar').classList.toggle('open');
$('#headerSettingsBtn').onclick=()=>$('.nav-item[data-page="settings"]').click();
$('#profileAvatar').onclick=()=>$('.nav-item[data-page="settings"]').click();
const chat=$('#chatDrawer');function openChat(prefill=''){if(!requireCore())return;chat.classList.add('open');chat.setAttribute('aria-hidden','false');if(prefill){$('#chatInput').value=prefill;setTimeout(()=>$('#chatForm').requestSubmit(),100)}}
$('#askFab').onclick=()=>chat.classList.contains('open')?chat.classList.remove('open'):openChat();$('#closeChat').onclick=()=>chat.classList.remove('open');
const answers=q=>{
  q=q.toLowerCase();
  const field=profile?.priorityField||'your priority field',crop=profile?.crops?.[0]||'your crop',region=regionData[profile?.region]||regionData.yakima;
  if(q.includes('tomorrow'))return weatherAnswer(true);
  if(q.includes('source')||q.includes('station'))return weatherSourcesAnswer();
  if(q.includes('weather')||q.includes('wind')||q.includes('temperature')||q.includes('forecast'))return weatherAnswer(false);
  if(q.includes('why')||q.includes(field.toLowerCase()))return `${field} is your saved priority, not a measured risk ranking. Open Agent jobs to review a plan based on your real fields, observations, and the available forecast.`;
  if(q.includes('water')||q.includes('irrig'))return 'No soil sensors or irrigation controls are connected. Log a field observation and inspect conditions; this app cannot prescribe an irrigation amount or operate equipment.';
  if(q.includes('changed'))return 'Your field notebook shows dated observations and Insights summarizes your saved work. Open Data & Intelligence for permitted field context and dated satellite comparisons. Missing or cloudy imagery cannot establish crop health; inventory and yield feeds are not connected.';
  return `I’m personalized for ${profile.firstName} at ${profile.farmName} near ${profile.location}. Ask why ${field} ranks first, what changed, or which sources support the brief.`;
};
function addMessage(text,type){
  const d=document.createElement('div');d.className=type+'-msg';d.textContent=text;
  if(type==='bot'&&text.includes('Open-Meteo')){
    const credit=document.createElement('div');credit.className='weather-message-source';
    const source=document.createElement('a');source.href='https://open-meteo.com/';source.textContent='Weather data by Open-Meteo';source.target='_blank';source.rel='noopener noreferrer';
    const licence=document.createElement('a');licence.href='https://creativecommons.org/licenses/by/4.0/';licence.textContent='CC BY 4.0';licence.target='_blank';licence.rel='noopener noreferrer';
    credit.append(source,document.createTextNode(' · '),licence);d.appendChild(credit);
  }
  $('#messages').appendChild(d);$('#messages').scrollTop=$('#messages').scrollHeight;
}
$('#chatForm').onsubmit=async e=>{e.preventDefault();const q=$('#chatInput').value.trim();if(!q||!requireCore())return;const ownerId=membership.user.id;addMessage(q,'user');$('#chatInput').value='';try{const reply=window.PhaseOne?await window.PhaseOne.answer(q):answers(q);if(membership?.user?.id===ownerId&&cloudEnabled&&typeof reply==='string'&&reply.trim())addMessage(reply,'bot');}catch(error){if(membership?.user?.id===ownerId&&cloudEnabled)addMessage(error.message||'Please retry your question.','bot');}};
$$('.quick-prompts button').forEach(b=>b.onclick=()=>openChat(b.textContent));$$('.ask-why').forEach(b=>b.onclick=()=>openChat(`Why ${profile?.priorityField||'Lower Gala'}?`));$$('.ask-weather').forEach(b=>b.onclick=()=>openChat('Why are you using these weather sources?'));$$('.ask-market').forEach(b=>b.onclick=()=>openChat('Review the irrigation plan'));$$('.ask-tractor').forEach(b=>b.onclick=()=>openChat('Review today’s heat safety steps'));$$('.ask-tomorrow').forEach(b=>b.onclick=()=>openChat('Help me plan around tomorrow'));
$('#retryWeatherBtn').onclick=()=>loadForecast(true);
let speaking=false;$('#listenBtn').onclick=()=>{if(!requireCore())return;window.PhaseOne?.speakBrief();};
$('#markRead').onclick=()=>{$$('.signal-card').forEach(c=>c.classList.remove('unread'));$$('.signal-head i').forEach(i=>i.style.display='none');toast('Morning updates marked as read')};
$('#startTaskBtn').onclick=()=>{if(requirePremium())openPage('jobs');};
let editingTaskId=null;
const modal=$('#modalBackdrop');
function showModal(task){
  if(!requireCore())return;const existing=tasks.includes(task)?task:null;editingTaskId=existing?.id??null;$('#taskForm').reset();$('#taskModalTitle').textContent=existing?'Edit farm task':'Add farm task';$('#newTaskName').value=existing?.name||'';$('#newTaskPlace').value=existing?.place||'';$('#newTaskDate').value=existing?.date||pacificDate();$('#newTaskTime').value=/^\d{2}:\d{2}$/.test(existing?.time||'')?existing.time:'';
  const select=$('#newTaskField');select.replaceChildren();const none=document.createElement('option');none.value='';none.textContent='Whole farm / no field';select.append(none);for(const field of window.FarmerWorkspace?.getFields()||[]){const option=document.createElement('option');option.value=field.id;option.textContent=field.name;select.append(option);}if(existing?.fieldId)select.value=existing.fieldId;
  modal.classList.add('open');setTimeout(()=>$('#newTaskName').focus(),50);
}
function hideModal(){modal.classList.remove('open');$('#taskForm').reset();editingTaskId=null;}$('#addTaskBtn').onclick=showModal;$$('.add-task-copy').forEach(b=>b.onclick=showModal);$('#closeModal').onclick=hideModal;$('#cancelModal').onclick=hideModal;modal.onclick=e=>{if(e.target===modal)hideModal()};
$('#taskForm').onsubmit=e=>{e.preventDefault();if(!requireCore())return;const existing=tasks.find(task=>task.id===editingTaskId),name=$('#newTaskName').value.trim();if(!name)return;if(!existing&&tasks.length>=300){toast('Save up to 300 tasks. Export older records before adding more.');return;}const field=(window.FarmerWorkspace?.getFields()||[]).find(item=>item.id===$('#newTaskField').value);const updated={...(existing||{id:'task-'+crypto.randomUUID(),done:false,createdAt:new Date().toISOString()}),name,place:$('#newTaskPlace').value.trim()||field?.name||'',date:$('#newTaskDate').value,time:$('#newTaskTime').value,status:$('#newTaskTime').value?'Scheduled':'Choose time'};if(field)updated.fieldId=field.id;else delete updated.fieldId;if(existing)tasks=tasks.map(task=>task.id===existing.id?updated:task);else tasks.push(updated);save();renderTasks();window.FarmerWorkspace?.render();saveCloudState();hideModal();toast(existing?'Task updated':'Task added')};
$('#photoBtn').onclick=()=>{if(requirePremium())window.FarmerWorkspace?.openObservation();};
$('#micBtn').onclick=()=>{if(!requireCore())return;const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){toast('Voice input is not supported here. You can type your question.');return}if(!confirm('Use your browser’s speech service? Audio may be processed by the browser provider. No recording is saved by Farmer Daily.'))return;const ownerId=membership.user.id,r=new SR();r.lang=/español|spanish|^es(?:-|$)/i.test(profile?.language||'')?'es-US':'en-US';r.onstart=()=>toast('Listening…');r.onerror=()=>toast('Voice input could not connect. Please type instead.');r.onresult=e=>{if(membership?.user?.id!==ownerId||!cloudEnabled)return;$('#chatInput').value=e.results[0][0].transcript;$('#chatForm').requestSubmit()};r.start()};
let toastTimer;function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2200)}

// Personalization is explicit and inspectable: this profile drives the brief, not just the greeting.
let profileStep=1;
function showProfileStep(n){profileStep=n;$$('.step').forEach(s=>s.classList.toggle('active',+s.dataset.step===n));$('#profileBack').style.display=n>1?'block':'none';$('#profileNext').style.display=n<4?'block':'none';$('#profileFinish').style.display=n===4?'block':'none';$('#stepDots').textContent=['● ○ ○ ○','○ ● ○ ○','○ ○ ● ○','○ ○ ○ ●'][n-1]}
function openProfileEditor(){const f=$('#profileForm');if(profile){Object.entries(profile).forEach(([k,v])=>{if(k==='crops'){v.forEach(c=>{const box=f.querySelector(`[name="crops"][value="${c}"]`);if(box)box.checked=true})}else{const input=f.elements[k];if(input){if(input.type==='checkbox')input.checked=!!v;else input.value=v}}})}showProfileStep(1);$('#onboarding').classList.remove('hidden')}
$('#profileNext').onclick=()=>{const current=$(`.step[data-step="${profileStep}"]`);const required=[...current.querySelectorAll('[required]')];if(required.some(i=>!i.value.trim())){required.find(i=>!i.value.trim()).reportValidity();return}showProfileStep(profileStep+1)};
$('#profileBack').onclick=()=>showProfileStep(profileStep-1);
$('#profileForm').onsubmit=e=>{
  e.preventDefault();if(!requireCore())return;
  const data=new FormData(e.target),locationId=data.get('locationId'),place=waLocations[locationId];if(!place)return;
  profile={...(profile||{}),firstName:data.get('firstName').trim(),farmName:data.get('farmName').trim(),locationId,location:place[0],address:data.get('address').trim(),region:place[3],role:data.get('role'),language:data.get('language'),phone:data.get('phone').trim(),smsOptIn:data.get('smsOptIn')==='on',safetySmsOptIn:data.get('safetySmsOptIn')==='on',whatsappOptIn:data.get('whatsappOptIn')==='on',safetyWhatsappOptIn:data.get('safetyWhatsappOptIn')==='on',crops:data.getAll('crops'),priorityField:data.get('priorityField').trim(),acres:data.get('acres'),wind:data.get('wind'),market:data.get('market'),tomorrowRain:data.get('tomorrowRain')==='on',briefTime:data.get('briefTime')||'06:30',scheduleEnabled:data.get('scheduleEnabled')==='on',notificationPreference:data.get('notificationPreference')||'in-app'};
  localStorage.setItem('farmerDailyProfile',JSON.stringify(profile));applyProfile();loadForecast();$('#onboarding').classList.add('hidden');saveCloudState();window.PhaseOne?.boot();toast('Farm profile saved. Add each field’s location and crop.');
};
$('#editProfileBtn').onclick=openProfileEditor;
// Account boot restores this signed-in user's profile before opening the app.

const gradientThemes=new Set(['sunrise','prairie','midnight']);
const themeNames={field:'Field',harvest:'Harvest',slate:'Slate',sunrise:'Sunrise',prairie:'Prairie',midnight:'Midnight',orchard:'Orchard',coastal:'Coastal',lavender:'Lavender',highcontrast:'High Contrast'};
function setTheme(theme,announce=false){
  if(typeof theme!=='string'||!Object.hasOwn(themeNames,theme))theme='field';
  document.body.dataset.theme=theme;localStorage.setItem('farmerDailyTheme',theme);
  $$('.theme-option').forEach(button=>{const selected=button.dataset.theme===theme;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  const badge=$('#themeTypeBadge');if(badge)badge.textContent=theme==='highcontrast'?'HIGH CONTRAST':gradientThemes.has(theme)?'GRADIENT':'SOLID';
  const browserColor=document.querySelector('meta[name="theme-color"]');if(browserColor)browserColor.content=getComputedStyle(document.body).getPropertyValue('--forest').trim();
  if(announce)toast(`${themeNames[theme]} theme applied`);
}
$('#themeGrid').onclick=e=>{const button=e.target.closest('.theme-option');if(button){setTheme(button.dataset.theme,true);saveCloudState();}};
setTheme(localStorage.getItem('farmerDailyTheme')||'field');

// A presentation preference, never a diagnosis or a change to farm content.
function readReadingPreferences(){
  let value;try{value=JSON.parse(localStorage.getItem('farmerDailyReadingPreferences')||'null');}catch{}
  return {enabled:value?.enabled===true,textSize:value?.textSize==='large'?'large':'comfortable'};
}
function applyReadingPreferences(){
  const value=readReadingPreferences();
  document.body.dataset.readingHelper=String(value.enabled);document.body.dataset.readingSize=value.textSize;
  $('#readingHelperEnabled').checked=value.enabled;$('#readingTextSize').value=value.textSize;$('#readingTextSize').disabled=!value.enabled;
  $('#readingHelperStatus').textContent=value.enabled?'Helper on. Your theme and farm records are unchanged.':'Helper off. Your usual text formatting is restored.';
}
let readingPreferenceRevision=0;
async function changeReadingPreferences(){
  if(!requireCore()){applyReadingPreferences();return;}
  const ownerId=membership?.user?.id,revision=++readingPreferenceRevision;
  let savedLocally=false;
  try{
    if(!cloudEnabled||!ownerId||localStorage.getItem('farmerDailyCloudOwner')!==ownerId){
      applyReadingPreferences();$('#readingHelperStatus').textContent='Reconnect your account before changing this preference.';return;
    }
    const value={enabled:$('#readingHelperEnabled').checked,textSize:$('#readingTextSize').value==='large'?'large':'comfortable'};
    localStorage.setItem('farmerDailyReadingPreferences',JSON.stringify(value));savedLocally=true;applyReadingPreferences();
    $('#readingHelperStatus').textContent='Saved on this device. Syncing your reading preference…';
    const result=await saveCloudState();
    if(revision!==readingPreferenceRevision||membership?.user?.id!==ownerId||localStorage.getItem('farmerDailyCloudOwner')!==ownerId)return;
    $('#readingHelperStatus').textContent=result?'Reading preference saved to your private account.':'Saved on this device only. Cloud sync is paused; your preference will retry when connected.';
  }catch{
    if(revision!==readingPreferenceRevision||membership?.user?.id!==ownerId||localStorage.getItem('farmerDailyCloudOwner')!==ownerId)return;
    if(!savedLocally)applyReadingPreferences();
    $('#readingHelperStatus').textContent=savedLocally?'Saved on this device only. Cloud sync is paused; retry when connected.':'This preference could not be saved. Check browser storage and try again.';
  }
}
$('#readingHelperEnabled').onchange=changeReadingPreferences;$('#readingTextSize').onchange=changeReadingPreferences;
$('#readingListenBrief').onclick=()=>{if(!requireCore())return;openPage('today');window.scrollTo(0,0);window.PhaseOne?.speakBrief();};
applyReadingPreferences();

// Contact settings are appended after the core profile renders and refreshed after edits.
appendContactSummary();

function updateDeliveryUi(now=Date.now()){if(!profile)return;$('#whatsappStatus').textContent='Manage verified delivery in Settings';$('#previewLocation').textContent=profile.location.toUpperCase();const greeting=farmClock(now,profile.language).greeting;$('#whatsappPreviewCopy').textContent=/español|spanish|^es(?:-|$)/i.test(profile.language||'')?`${greeting}, ${profile.firstName}. Su prioridad guardada es ${profile.priorityField}. Revise los registros de sus parcelas y el pronóstico actual en Farmer Daily antes de planificar el trabajo. Este borrador no se ha enviado. Configure la entrega real en Settings → Messages & WhatsApp.`:`${greeting}, ${profile.firstName}. Your saved priority is ${profile.priorityField}. Review your field records and the current forecast in Farmer Daily before planning work. This is an unsent draft. Set up real delivery in Settings → Messages & WhatsApp.`;}
$('#profileForm').addEventListener('submit',e=>{const data=new FormData(e.target),whatsappOptIn=data.get('whatsappOptIn')==='on',safetyWhatsappOptIn=data.get('safetyWhatsappOptIn')==='on';setTimeout(()=>{profile.whatsappOptIn=whatsappOptIn;profile.safetyWhatsappOptIn=safetyWhatsappOptIn;localStorage.setItem('farmerDailyProfile',JSON.stringify(profile));updateDeliveryUi();appendContactSummary()},0)});
updateDeliveryUi();

const observationModal=$('#observationBackdrop');
function showObservation(){window.FarmerWorkspace?.openObservation();}
function hideObservation(){window.FarmerWorkspace?.cancelPhoto();observationModal.classList.remove('open');$('#observationForm').reset()}
$('#logObservationBtn').onclick=showObservation;$('#closeObservation').onclick=hideObservation;$('#cancelObservation').onclick=hideObservation;observationModal.onclick=e=>{if(e.target===observationModal)hideObservation()};
// Field notebook binds observation submission after the authenticated app boots.
$('#quickAddTaskBtn').onclick=showModal;
const channelPreview=$('#channelPreview');$('#whatsappPreviewBtn').onclick=()=>{updateDeliveryUi();channelPreview.classList.add('open');channelPreview.setAttribute('aria-hidden','false')};$('#closeChannelPreview').onclick=()=>{channelPreview.classList.remove('open');channelPreview.setAttribute('aria-hidden','true')};$('#editDeliveryBtn').onclick=()=>{channelPreview.classList.remove('open');channelPreview.setAttribute('aria-hidden','true');openPage('settings');window.FarmerFocusedViews?.reveal('#messagingSettings');$('#messagingSettings')?.scrollIntoView({block:'start'});};
function setSyncStatus(message){$('#syncLabel').textContent=message;document.querySelectorAll('[data-sync-status]').forEach(node=>{node.textContent=message;});}
function updateConnection(){const online=navigator.onLine;setSyncStatus(online?'Saved on this device':'Offline · changes kept on this device');$('.sync-state').classList.toggle('offline',!online)}
window.addEventListener('online',updateConnection);window.addEventListener('offline',updateConnection);updateConnection();

const defaultJobs=[];
let agentJobs=JSON.parse(localStorage.getItem('farmerDailyJobs')||'null')||defaultJobs;
let jobEvents=JSON.parse(localStorage.getItem('farmerDailyJobEvents')||'[]');
function saveJobs(){if(!membershipAllowsPremium())return;localStorage.setItem('farmerDailyJobs',JSON.stringify(agentJobs));localStorage.setItem('farmerDailyJobEvents',JSON.stringify(jobEvents))}
function renderJobs(){window.FarmerWorkspace?.renderJobs();}
function runJob(id){return window.FarmerWorkspace?.approveJob(id);}
function dismissJob(id){return window.FarmerWorkspace?.dismissJob(id);}
const jobModal=$('#jobBackdrop');$('#createJobBtn').onclick=()=>window.FarmerWorkspace?.openJob();$('#closeJobModal').onclick=$('#cancelJobModal').onclick=()=>{window.FarmerWorkspace?.cancelPreparation();jobModal.classList.remove('open');};jobModal.onclick=e=>{if(e.target===jobModal){window.FarmerWorkspace?.cancelPreparation();jobModal.classList.remove('open');}};renderJobs();

$('#exportDataBtn').onclick=async()=>{
  try{
    const expected=membership?.user?.id;
    if(!expected||!cloudEnabled||localStorage.getItem('farmerDailyCloudOwner')!==expected)throw new Error('Reconnect your account before exporting.');
    const localFarmData={};
    for(const [name,key] of Object.entries(farmStorageKeys)){const value=localStorage.getItem(key);if(value!==null)localFarmData[name]=name==='theme'?value:JSON.parse(value);}
    const deviceRecoveryCopy=JSON.parse(localStorage.getItem('farmerDailyDeviceBackup:'+expected)||'null');
    const results=await Promise.allSettled([memberFetch('/api/state?export=1'),memberFetch('/api/brief')]);
    for(const result of results)if(result.status==='rejected'&&[401,403,409].includes(result.reason?.status))throw result.reason;
    if(membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected)throw new Error('Your signed-in account changed. Reload before exporting.');
    const data={exportedAt:new Date().toISOString(),localFarmData,deviceRecoveryCopy,localSnapshotNotice:'Device snapshot, including changes not yet synchronized. Cloud snapshot may be older; recovery copy may contain older records.',farmData:results[0].status==='fulfilled'?results[0].value:null,dailyBrief:results[1].status==='fulfilled'?results[1].value:null,cloudAvailable:results.every(result=>result.status==='fulfilled'),account:{user:membership.user,plan:membership.plan,request:membership.request}};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),link=document.createElement('a');
    link.href=url;link.download='farmer-daily-data.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(data.cloudAvailable?'Export includes your current device and cloud snapshots.':'Device records exported. Cloud records were unavailable.');
  }catch(error){toast(error.message);}
};
let cloudEnabled=false,cloudSyncing=false,lastCloudPayload='',cloudSavePromise=null,cloudWorkflowRevision=0,serverWorkflowPromise=null;
function collectCloudState(){
  const basic={profile:JSON.parse(localStorage.getItem('farmerDailyProfile')||'null'),theme:localStorage.getItem('farmerDailyTheme')||'field',readingPreferences:readReadingPreferences(),fields:JSON.parse(localStorage.getItem('farmerDailyFields')||'[]'),tasks:JSON.parse(localStorage.getItem('farmerDailyTasks')||'[]')};
  if(!membershipAllowsPremium())return basic;
  return {...basic,fields:JSON.parse(localStorage.getItem('farmerDailyFields')||'[]'),tasks:JSON.parse(localStorage.getItem('farmerDailyTasks')||'[]'),observations:JSON.parse(localStorage.getItem('farmerDailyObservations')||'[]'),jobs:JSON.parse(localStorage.getItem('farmerDailyJobs')||'[]'),jobEvents:JSON.parse(localStorage.getItem('farmerDailyJobEvents')||'[]')};
}
async function saveCloudState(){
  const expected=membership?.user?.id;
  if(serverWorkflowPromise)await serverWorkflowPromise;
  if(!cloudEnabled)return false;
  if(!expected||membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected){cloudEnabled=false;window.FarmerBriefVoice?.clear();location.reload();return false;}
  if(cloudSavePromise){
    // All waiters share a failed attempt instead of each retrying it in turn.
    // A later explicit save/autosave may retry; it must not create a long queue.
    const saved=await cloudSavePromise;
    if(!saved||!cloudEnabled||membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected)return false;
    return saveCloudState();
  }
  const state=collectCloudState(),payload=JSON.stringify(state);
  if(payload===lastCloudPayload){setSyncStatus('Protected in Azure');return true;}
  cloudSavePromise=(async()=>{
    setSyncStatus('Saving securely to Azure…');
    try{const result=await memberFetch('/api/state',{method:'PUT',body:payload,headers:{'X-Farmer-Workflow-Revision':String(cloudWorkflowRevision)}});if(!cloudEnabled||membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected)return false;lastCloudPayload=payload;if(result?.updatedAt)localStorage.setItem('farmerDailyRemoteUpdatedAt',result.updatedAt);setSyncStatus('Protected in Azure');return true;}
    catch(error){setSyncStatus(error.status===409?'Tasks changed in Azure. Reload before saving; device changes were kept.':'Cloud sync paused · changes kept on this device');return false;}
    finally{cloudSavePromise=null;}
  })();
  return cloudSavePromise;
}
const farmStorageKeys={profile:'farmerDailyProfile',fields:'farmerDailyFields',tasks:'farmerDailyTasks',observations:'farmerDailyObservations',jobs:'farmerDailyJobs',jobEvents:'farmerDailyJobEvents',theme:'farmerDailyTheme',readingPreferences:'farmerDailyReadingPreferences'};
function bindAccountStorage(account,remote){
  window.FarmerBriefVoice?.clear();
  window.FarmerAiBrief?.clear();
  window.FarmerIntelligence?.clear();
  window.ConnectedFarm?.clear();
  window.FarmerMessaging?.clear();
  const previous=localStorage.getItem('farmerDailyCloudOwner');
  const knownRevision=localStorage.getItem('farmerDailyRemoteUpdatedAt');
  if(previous!==account.user.id||!remote||(remote.updatedAt&&remote.updatedAt!==knownRevision)||String(remote.workflowRevision||0)!==(localStorage.getItem('farmerDailyWorkflowRevision')||'0')){
    const archive={};
    for(const key of Object.values(farmStorageKeys)){const value=localStorage.getItem(key);if(value!==null)archive[key]=value;}
    if(Object.keys(archive).length)localStorage.setItem('farmerDailyDeviceBackup:'+(previous||'legacy'),JSON.stringify(archive));
    for(const key of Object.values(farmStorageKeys))localStorage.removeItem(key);
    localStorage.removeItem('farmerDailyForecastCacheV2');
    localStorage.setItem('farmerDailyCloudOwner',account.user.id);
    if(remote?.updatedAt)localStorage.setItem('farmerDailyRemoteUpdatedAt',remote.updatedAt);
    else localStorage.removeItem('farmerDailyRemoteUpdatedAt');
  }
  for(const [field,key] of Object.entries(farmStorageKeys)){
    if(remote?.[field]!=null&&localStorage.getItem(key)===null)localStorage.setItem(key,field==='theme'?remote[field]:JSON.stringify(remote[field]));
  }
  cloudWorkflowRevision=Number.isSafeInteger(remote?.workflowRevision)?remote.workflowRevision:0;
  localStorage.setItem('farmerDailyWorkflowRevision',String(cloudWorkflowRevision));
}
function sameWorkflowValue(left,right){
  if(left===right)return true;
  if(left===null||right===null||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameWorkflowValue(left[key],right[key]));
}
function applyServerWorkflowState(remote,expected){
  if(!remote)return;
  if(!cloudEnabled||membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected)throw new Error('Account changed. Reload before viewing workflow results.');
  if(!Array.isArray(remote.tasks)||!Number.isSafeInteger(remote.workflowRevision)||remote.workflowRevision<cloudWorkflowRevision)throw new Error('Workflow sync returned an invalid task revision. Reload before continuing.');
  const current=collectCloudState();
  if(Object.keys(current).some(key=>key!=='tasks'&&!sameWorkflowValue(current[key],remote[key]))){
    localStorage.setItem('farmerDailyDeviceBackup:'+expected,JSON.stringify(current));cloudEnabled=false;
    throw new Error('Newer farm edits were found in Azure. Reload to reconcile the workflow and your farm; your device copy was retained.');
  }
  localStorage.setItem('farmerDailyTasks',JSON.stringify(remote.tasks));
  localStorage.setItem('farmerDailyWorkflowRevision',String(remote.workflowRevision));
  if(remote.updatedAt)localStorage.setItem('farmerDailyRemoteUpdatedAt',remote.updatedAt);
  tasks=remote.tasks;cloudWorkflowRevision=remote.workflowRevision;lastCloudPayload=JSON.stringify(collectCloudState());
  renderTasks();window.FarmerWorkspace?.render();setSyncStatus('Protected in Azure');
}
async function runServerWorkflowRequest(callback){
  if(serverWorkflowPromise)throw new Error('Another workflow is still running. Please wait.');
  const expected=membership?.user?.id;
  if(!membershipAllowsPremium()||!expected||!await saveCloudState())throw new Error('Synchronize your farm records before reviewing or running a workflow.');
  if(serverWorkflowPromise)throw new Error('Another workflow is still running. Please wait.');
  if(membership?.user?.id!==expected||!cloudEnabled)throw new Error('Account changed. Reload before continuing.');
  const before=JSON.stringify(collectCloudState());let release;
  serverWorkflowPromise=new Promise(resolve=>{release=resolve;});document.querySelector('.shell').inert=true;
  try{
    const result=await callback();
    if(result?.state){
      if(before!==JSON.stringify(collectCloudState())){
        localStorage.setItem('farmerDailyDeviceBackup:'+expected,JSON.stringify(collectCloudState()));cloudEnabled=false;
        throw new Error('Device records changed while the workflow ran. Reload to see the server result; your device copy was retained.');
      }
      applyServerWorkflowState(result.state,expected);
    }
    return result;
  }catch(error){
    // A timed-out mutation may have committed. Stop subsequent auto-saves until
    // a reload fetches the authoritative task revision; never retry execution.
    if(!Number.isInteger(error.status)||error.status>=500){cloudEnabled=false;setSyncStatus('Workflow result uncertain. Reload to reconcile before saving.');}
    throw error;
  }finally{serverWorkflowPromise=null;release();if(membership?.user?.id===expected&&document.querySelector('#accountGate').hidden)document.querySelector('.shell').inert=false;}
}
window.applyServerWorkflowState=applyServerWorkflowState;
window.runServerWorkflowRequest=runServerWorkflowRequest;
async function initializeCloud(){
  const account=await membershipReady;
  if(!account)return;
  try{
    const remote=await memberFetch('/api/state');
    bindAccountStorage(account,remote);
    setTheme(localStorage.getItem('farmerDailyTheme')||'field');
    readingPreferenceRevision++;applyReadingPreferences();
    profile=JSON.parse(localStorage.getItem('farmerDailyProfile')||'null');
    tasks=membershipAllowsCore()?(JSON.parse(localStorage.getItem('farmerDailyTasks')||'null')||[]):[];
    agentJobs=membershipAllowsPremium()?(JSON.parse(localStorage.getItem('farmerDailyJobs')||'null')||[]):[];
    jobEvents=membershipAllowsPremium()?(JSON.parse(localStorage.getItem('farmerDailyJobEvents')||'null')||[]):[];
    renderTasks();renderJobs();
    if(profile?.locationId&&waLocations[profile.locationId]){applyProfile();appendContactSummary();updateDeliveryUi();$('#onboarding').classList.add('hidden');}
    else{profile=null;$('#onboarding').classList.remove('hidden');showProfileStep(1);}
    cloudEnabled=true;lastCloudPayload='';window.FarmerWorkspace?.render();
    const hero=$('.privacy-hero');hero.querySelector('b').textContent='Private Azure cloud account';
    hero.querySelector('p').textContent='Your fields, tasks, briefs and derived history belong to your signed-in account; admins see account metadata and access requests, not farm records. Weather, Farm Context and satellite each have separate field permissions and receive only their required location/context inputs. The optional map receives viewed tiles and your IP. Calendar connection is separate: only an approved event title and schedule go to your chosen Outlook/Google calendar, not farm notes, boundaries or guests. Optional messaging stores a verified number encrypted on the server. With separate channel consent, Twilio (and Meta for WhatsApp) receives that number and a brief excerpt. Messages may appear on a phone lock screen. Calendar credentials remain encrypted on the server and never enter exports. Device farm copies are not separately encrypted—use your own browser profile.';
    $('#dataInventory').textContent='Export includes farm records, connection metadata, action history and up to 366 daily AI attempt counters, never connection credentials. Delete removes farm records, saved calendar credentials and messaging enrollment, stopping future app requests. Previously sent messages and calendar events remain with recipients/providers; an already submitted action may still finish. Account access/request history and minimal daily AI attempt counters remain to prevent quota resets. AI prompts and answers are not saved as farm records. Revoke calendar app permissions in that provider.';
    hero.querySelector('p').append(document.createTextNode(' Optional OpenAI processing requires approval for each request and sends minimized field aliases, crop/stage categories, task counts and source measurements—not names, contact details, coordinates or private notes. Read-only tools still obey your field permissions. Provider abuse-monitoring and caching policies may apply even with store:false.'));
    const signout=document.createElement('a');signout.className='secondary signout-link';signout.href='/.auth/logout';signout.textContent='Sign out';$('.data-controls').appendChild(signout);
    finishAccountBoot();
    if(profile)await saveCloudState();
    setInterval(()=>{if(!document.hidden)saveCloudState();},5000);
  }catch(error){cloudEnabled=false;showAccountError(error);}
}
initializeCloud();

// Free device speech is optional, bound to the current private account and brief.
// Voice choices are not farm records and never enter the cloud state payload.
function voiceOwner(){
  const owner=membership?.user?.id;
  return membershipAllowsCore()&&cloudEnabled&&owner&&
    localStorage.getItem('farmerDailyCloudOwner')===owner&&$('#accountGate').hidden?owner:null;
}
window.syncBriefVoiceContext=()=>{
  if(!window.FarmerBriefVoice)return null;
  const context={owner:voiceOwner(),briefKey:JSON.stringify([savedDailyBriefOwner,savedDailyBrief]),page:$('.page.active')?.id||''};
  window.FarmerBriefVoice.setContext(context);
  return context;
};
window.mountBriefVoiceUi=()=>{
  const voice=window.FarmerBriefVoice;if(!voice)return;
  voice.configure({getOwner:voiceOwner,getLanguage:()=>profile?.language||'English'});
  const settings=$('#briefVoiceSettings');
  if(settings)voice.mountSettings(settings);
  const player=$('#briefVoicePlayer');if(player)voice.mountPlayer(player);
  window.syncBriefVoiceContext();
};
document.addEventListener('DOMContentLoaded',()=>{window.mountBriefVoiceUi();window.FarmerFocusedViews?.refresh();});

// Clear this authenticated owner's device copy when explicitly signing out.
// Unsynced data is never discarded without a separate warning and confirmation.
let signingOut=false;
document.addEventListener('click',async event=>{
  const link=event.target.closest?.('a[href="/.auth/logout"]');
  if(!link)return;
  event.preventDefault();if(signingOut)return;signingOut=true;
  window.FarmerBriefVoice?.clear();
  const expected=membership?.user?.id;
  try{
    if(expected&&localStorage.getItem('farmerDailyCloudOwner')===expected){
      const synced=cloudEnabled?await saveCloudState():false;
      if(!synced&&!confirm('Some device records may not be saved to Azure. Cancel to export them first, or continue to sign out and remove this account’s device copy.'))return;
      if(synced&&localStorage.getItem('farmerDailyDeviceBackup:'+expected)&&!confirm('Sign out and clear this account’s device records, including its older recovery copy? Cancel to export that copy first. Your saved Azure records will remain.'))return;
      if(membership?.user?.id!==expected||localStorage.getItem('farmerDailyCloudOwner')!==expected)throw new Error('Account changed. Reload before signing out.');
      cloudEnabled=false;
      window.FarmerIntelligence?.clear();
      window.ConnectedFarm?.clear();
      window.FarmerMessaging?.clear();
      window.FarmerAiBrief?.clear();
      for(const key of Object.values(farmStorageKeys))localStorage.removeItem(key);
      for(const key of ['farmerDailyForecastCacheV2','farmerDailyRemoteUpdatedAt','farmerDailyWorkflowRevision','farmerDailyCloudOwner','farmerDailyDeviceBackup:'+expected])localStorage.removeItem(key);
    }
    location.assign('/.auth/logout');
  }catch(error){toast(error.message);}
  finally{signingOut=false;}
});

window.addEventListener('storage',event=>{
  if(event.key==='farmerDailyCloudOwner'&&membership?.user?.id&&event.newValue!==membership.user.id){
    cloudEnabled=false;window.FarmerBriefVoice?.clear();window.FarmerIntelligence?.clear();window.ConnectedFarm?.clear();window.FarmerMessaging?.clear();window.FarmerAiBrief?.clear();document.querySelector('.shell').inert=true;location.reload();
  }
});

// Installable app support. The service worker deliberately excludes authentication,
// API responses, and farmer records from its cache.
let deferredInstallPrompt=null;
const installBanner=$('#installBanner'),installButton=$('#installAppBtn'),installHelp=$('#installHelp');
const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
const isAppleMobile=()=>/iphone|ipad|ipod/i.test(navigator.userAgent);
function updateInstallBanner(){
  if(isStandalone()||sessionStorage.getItem('farmerDailyInstallDismissed')==='yes'){installBanner.hidden=true;return}
  installBanner.hidden=false;
  if(isAppleMobile()){
    installButton.textContent='How to install';
    installHelp.textContent='In Safari, tap Share, then Add to Home Screen.';
  }else if(deferredInstallPrompt){
    installButton.textContent='Install app';
    installHelp.textContent='Open it full-screen from your home screen.';
  }else{
    installButton.textContent='Install instructions';
    installHelp.textContent='Use your browser menu and choose Install app.';
  }
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;updateInstallBanner()});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;installBanner.hidden=true;toast('Farmer Daily is installed')});
installButton.onclick=async()=>{
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt=null;
    updateInstallBanner();
    return;
  }
  toast(isAppleMobile()?'In Safari: tap Share, then Add to Home Screen':'Open the browser menu and choose Install app');
};
$('#dismissInstallBtn').onclick=()=>{sessionStorage.setItem('farmerDailyInstallDismissed','yes');installBanner.hidden=true};
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(()=>{}));
updateInstallBanner();

$('#deleteDataBtn').onclick=async()=>{
  if(!confirm('Permanently delete your private farm records, derived data, briefs, equipment, readings, knowledge, workflow history and saved calendar credentials? Calendars/events already copied to Outlook or Google remain there; an action already sent may still finish. Revoke provider permissions separately. Account access and early-access request history remain. This cannot be undone.'))return;
  try{
    if(serverWorkflowPromise)await serverWorkflowPromise;
    cloudEnabled=false;window.FarmerBriefVoice?.clear();window.FarmerIntelligence?.clear();window.ConnectedFarm?.clear();window.FarmerMessaging?.clear();window.FarmerAiBrief?.clear();if(cloudSavePromise)await cloudSavePromise;
    await memberFetch('/api/state',{method:'DELETE'});
    for(const key of Object.values(farmStorageKeys))localStorage.removeItem(key);
    localStorage.removeItem('farmerDailyForecastCacheV2');
    localStorage.removeItem('farmerDailyDeviceBackup:'+membership.user.id);
    localStorage.removeItem('farmerDailyWorkflowRevision');
    location.reload();
  }catch(error){cloudEnabled=true;toast(error.message);}
};
