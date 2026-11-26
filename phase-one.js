'use strict';
(() => {
  const get=id=>document.getElementById(id);
  const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;};
  const button=(text,action,className='secondary')=>{const b=el('button',className,text);b.type='button';b.onclick=action;return b;};
  const es=()=>/español|spanish|^es(?:-|$)/i.test(profile?.language||'');
  const tr=(en,sp)=>es()?sp:en;
  const fields=()=>window.FarmerWorkspace?.getFields()||[];
  const stamp=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(es()?'es-US':'en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):tr('Unavailable','No disponible');
  let autoRunning=false,lastAutoAttempt=0,bootOwner=null;
  const notified=new Set();

  function sourceLink(source){
    try{
      const url=new URL(source.url),allowed=['api.weather.gov','forecast.weather.gov','www.weather.gov','weather.gov','open-meteo.com','api.open-meteo.com','epqs.nationalmap.gov','www.usgs.gov','apps.nationalmap.gov','sdmdataaccess.nrcs.usda.gov','mymarketnews.ams.usda.gov','quickstats.nass.usda.gov','www.airnow.gov','ecology.wa.gov','earth-search.aws.element84.com'];
      if(url.protocol!=='https:'||!allowed.includes(url.hostname)||url.port||url.username||url.password)return null;
      const a=el('a','',source.name||url.hostname);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';return a;
    }catch{return null;}
  }
  function renderAdvisories(brief){
    const list=get('dailyBriefItems'),expanded=new Set([...list.querySelectorAll('li[data-advisory-id]')].filter(item=>item.querySelector('details')?.open).map(item=>item.dataset.advisoryId));list.replaceChildren();list.classList.add('advisory-list');
    get('dailyBriefHeading').textContent=tr(`${brief.advisories.length} ${brief.advisories.length===1?'priority':'priorities'} for today`,`${brief.advisories.length} prioridades para hoy`);
    for(const advisory of brief.advisories.slice(0,3)){
      const li=el('li','advisory-card'),expired=!Number.isFinite(Date.parse(advisory.validUntil))||Date.parse(advisory.validUntil)<=Date.now();li.dataset.advisoryId=advisory.id;
      li.dataset.priority=['high','medium','low'].includes(advisory.priority)?advisory.priority:'low';
      li.append(el('small','advisory-field',`${advisory.fieldName||''} · ${advisory.priority||''}`),el('h3','',advisory.title),el('p','advisory-change',advisory.whatChanged));
      if(expired)li.append(el('p','advisory-expired',tr('This saved advisory has expired. Refresh before using it.','Este aviso guardado venció. Actualícelo antes de usarlo.')));
      const details=el('details','advisory-reason'),summary=el('summary','',tr('Why this matters and what you could do','Por qué importa y qué puede hacer'));details.append(summary);
      for(const [label,value] of [[tr('Why it matters','Por qué importa'),advisory.whyItMatters],[tr('Suggested next step','Siguiente paso'),advisory.suggestedAction],[tr('Confidence','Confianza'),advisory.confidence],[tr('Valid until','Válido hasta'),stamp(advisory.validUntil)]]){
        const p=el('p','');p.append(el('b','',`${label}: `),document.createTextNode(value||'—'));details.append(p);
      }
      const sources=el('div','advisory-sources');
      for(const source of advisory.sources||[]){const link=sourceLink(source);if(link){const item=el('p','');item.append(link,document.createTextNode(` · ${stamp(source.fetchedAt)}`));sources.append(item);if(typeof source.attribution==='string')sources.append(el('p','',source.attribution.slice(0,240)));}}
      if((advisory.sources||[]).some(source=>/open-meteo/i.test(source.url||source.name||''))){const p=el('p','');const a=el('a','','CC BY 4.0');a.href='https://creativecommons.org/licenses/by/4.0/';a.target='_blank';a.rel='noopener noreferrer';p.append(a,document.createTextNode(tr(' · Open-Meteo data; units and wording adapted.',' · Datos de Open-Meteo; unidades y texto adaptados.')));sources.append(p);}
      details.open=expanded.has(advisory.id);details.append(sources);li.append(details);
      const actions=el('div','advisory-actions');actions.append(button(advisory.followUp||tr('Ask why','Preguntar por qué'),()=>openChat(`${tr('Why','Por qué')} ${advisory.fieldName}: ${advisory.title}`),'text-btn'));
      if(advisory.fieldId)actions.append(button(tr('View field','Ver parcela'),()=>{if(['soil-context','market-report','air-awareness','regional-drought','satellite-scout'].includes(advisory.kind)){window.FarmerIntelligence?.select(advisory.fieldId);}else{openPage('fields');window.FarmerFieldMap?.loadFieldData(advisory.fieldId);}}));
      actions.append(button(tr('Add a task','Añadir tarea'),()=>{showModal();if(advisory.fieldId)get('newTaskField').value=advisory.fieldId;get('newTaskName').value=(advisory.suggestedAction||advisory.title||'').slice(0,200);}));
      li.append(actions);list.append(li);
    }
    const notice=get('briefCoverage');notice.replaceChildren();
    for(const text of brief.coverage?.notices||[])notice.append(el('p','',text));
    notice.append(el('p','',brief.explanation||tr('Priorities are selected by explainable rules using recorded weather and tasks.','Las prioridades usan reglas explicables, el pronóstico y las tareas guardadas.')));
    renderProgress();
  }
  function freshData(){return window.FarmerFieldMap?.cachedData()||[];}
  function renderProgress(){
    if(!get('intelligenceRows'))return;
    const all=fields(),data=freshData(),located=all.filter(field=>field.location),boundaries=all.filter(field=>field.boundary);
    const stats=[
      [tr('Farm setup','Configuración de la finca'),profile?.farmName||tr('Add your farm','Añada su finca')],
      [tr('Field locations','Ubicaciones'),`${located.length} / ${all.length} ${tr('fields located','parcelas ubicadas')} · ${boundaries.length} ${tr('boundaries','límites')}`],
      [tr('Usable forecasts this session','Pronósticos utilizables en esta sesión'),`${data.filter(item=>validForecast(item.weather)).length} ${tr('fields; cached forecasts may be included. Open a field for source times.','parcelas; puede incluir pronósticos guardados. Abra una parcela para ver las fechas.')}`],
      [tr('Elevation loaded this session','Elevación cargada'),`${data.filter(item=>item.elevation?.status==='loaded').length} ${tr('fields','parcelas')}`],
      [tr('Tasks','Tareas'),`${tasks.filter(task=>!task.done).length} ${tr('unfinished','pendientes')}`]
    ];
    get('farmDataStatus').replaceChildren();for(const [name,value]of stats){const row=el('div','data-status-row');row.append(el('b','',name),el('span','',value));get('farmDataStatus').append(row);}
    get('intelligenceRows').replaceChildren();
    for(const item of window.FarmerBuildProgress?.features||[]){const row=el('article','intelligence-row'),copy=el('div','');copy.append(el('b','',`${item.name} · Phase ${item.phase}`),el('p','',item.detail));const badge=el('span','maturity-badge',item.status);badge.dataset.status=item.status;row.append(copy,badge);get('intelligenceRows').append(row);}
    get('devStatusLink').hidden=!membership?.isAdmin;
    if(get('homeFieldCount'))get('homeFieldCount').textContent=tr(`You have ${all.length} fields. ${located.length} have a location.`,`Tiene ${all.length} parcelas. ${located.length} tienen ubicación.`);
    get('scheduleDescription').textContent=profile?.scheduleEnabled?tr(`Enabled for ${profile.briefTime} Pacific, while open or when you return.`,`Activado a las ${profile.briefTime}, hora del Pacífico, con la app abierta o al volver.`):tr('Automatic preparation is off. Enable it in your farm profile.','La preparación automática está desactivada. Actívela en su perfil.');
    const preference=profile?.notificationPreference||'in-app';
    get('notificationPermissionBtn').hidden=preference!=='browser';
    get('notificationStatus').textContent=preference==='browser'?(!('Notification'in window)?tr('This browser does not support notifications. In-app notices still work.','Este navegador no admite notificaciones.'):tr(`Browser permission: ${Notification.permission}. Notifications are sent only while this app is running.`,`Permiso del navegador: ${Notification.permission}. Solo se envían con la app abierta.`)):tr('These notices stay in the app. For separately verified SMS/WhatsApp delivery, open Messages & WhatsApp below. Closed-app browser push is not connected.','Estos avisos quedan en la app. Para SMS/WhatsApp con verificación separada, abra Messages & WhatsApp abajo. Las notificaciones push con la app cerrada no están conectadas.');
  }
  async function notifyReady(date,expected){
    if(membership?.user?.id!==expected||!cloudEnabled)return;
    const key=`${expected}:${date}`;if(notified.has(key))return;notified.add(key);
    if(profile?.notificationPreference==='off')return;
    toast(tr('Your daily brief is ready.','Su resumen diario está listo.'));
    if(profile?.notificationPreference!=='browser'||!('Notification'in window)||Notification.permission!=='granted')return;
    const options={body:tr('Your brief is ready. Open Farmer Daily to view it.','Su resumen está listo. Abra Farmer Daily para verlo.'),tag:`farmer-daily-${date}`,icon:'/icons/icon-192.png'};
    try{
      const registration=await navigator.serviceWorker?.getRegistration();
      if(membership?.user?.id!==expected||!cloudEnabled)return;
      if(registration)await registration.showNotification('Farmer Daily',options);else new Notification('Farmer Daily',options);
    }catch{get('notificationStatus').textContent=tr('Browser notification unavailable; your brief is ready in the app.','La notificación no está disponible; su resumen está listo en la app.');}
  }
  async function checkSchedule(){
    if(autoRunning||!cloudEnabled||!membershipAllowsCore()||!window.FarmerSchedule?.shouldPrepare({profile,brief:savedDailyBrief,visible:!document.hidden})||Date.now()-lastAutoAttempt<5*60000)return;
    const expected=membership.user.id;lastAutoAttempt=Date.now();autoRunning=true;
    try{const result=await loadDailyBrief(true);if(result?.brief&&membership?.user?.id===expected)await notifyReady(result.brief.date,expected);}finally{autoRunning=false;}
  }
  function speakBrief(){
    const voice=window.FarmerBriefVoice,context=window.syncBriefVoiceContext?.();
    if(!context?.owner||!cloudEnabled||!membershipAllowsCore()||savedDailyBriefOwner!==context.owner){voice?.clear();toast(tr('Sign in and load your saved brief before listening.','Inicie sesión y cargue su resumen antes de escucharlo.'));return;}
    if(!savedDailyBrief?.items){voice?.stop();toast(tr('Prepare your brief first.','Prepare su resumen primero.'));return;}
    if(!voice){toast(tr('Voice controls could not load. Refresh the app and try again.','No se cargaron los controles de voz. Actualice la app e inténtelo de nuevo.'));return;}
    const state=voice.getState();
    if(state.status==='playing'&&!state.isPreview){voice.pause();return;}
    if(state.status==='paused'&&!state.isPreview){voice.resume();return;}
    const result=voice.playBrief(savedDailyBrief,{owner:context.owner,briefKey:context.briefKey,language:profile?.language});
    if(!result.ok)toast(result.reason);
  }
  async function answer(question){
    const q=String(question||'').trim().toLocaleLowerCase(),all=fields(),expected=membership?.user?.id;
    const sameOwner=()=>!!expected&&membership?.user?.id===expected&&cloudEnabled&&localStorage.getItem('farmerDailyCloudOwner')===expected;
    if(!sameOwner())return '';
    if(/\b(send|enviar|buy|comprar|order|submit|assign|asignar)\b/.test(q))return tr('No external action was taken. Connected workflows are planned for Frontier Farm; you can add a task manually.','No se realizó ninguna acción externa. Los flujos conectados están previstos para Frontier Farm; puede añadir una tarea.');
    if(/\b(create|add|schedule|crear|añadir|programar)\b/.test(q)&&/task|tarea/.test(q)){showModal();return tr('The task form is open. Choose the field and date, review it, then save. Nothing was created yet.','El formulario está abierto. Elija la parcela y la fecha, revise y guarde. Aún no se creó ninguna tarea.');}
    const field=all.filter(item=>q.includes(item.name.toLocaleLowerCase())).sort((a,b)=>b.name.length-a.name.length)[0];
    if(/why|por qu[eé]|porqu[eé]|changed|cambi|priori[td]/.test(q)){
      const detailed=brief=>!brief?.deleted&&Array.isArray(brief?.advisories)?brief.advisories.filter(item=>item&&typeof item.title==='string'&&typeof item.whatChanged==='string'&&typeof item.whyItMatters==='string'):[];
      // Read the owner's existing snapshot only. Asking why never generates a new brief or task.
      let brief=savedDailyBriefOwner===expected?savedDailyBrief:null;
      if(!detailed(brief).length||brief.date!==pacificDate()){
        let result;
        try{result=await loadDailyBrief(false);}catch{ /* Give a retry path, never the generic prompt again. */ }
        if(!sameOwner())return '';
        if(!result)return tr('I couldn’t load your saved brief, so I can’t verify its reasons right now. Open Today and retry loading the brief. No new brief or task was created.','No pude cargar su resumen guardado, así que no puedo verificar los motivos ahora. Abra Hoy y vuelva a cargar el resumen. No se creó ningún resumen ni tarea.');
        brief=result.deleted?{deleted:true}:result.brief;
      }
      if(brief?.deleted)return tr('Your saved brief was deleted with your farm data. Complete your farm setup, then open Today and choose “Get today’s brief” to prepare new priorities.','Su resumen se eliminó con los datos de la finca. Complete la configuración y abra Hoy → “Get today’s brief” para preparar nuevas prioridades.');
      const advisories=detailed(brief);
      if(!advisories.length){
        if(brief)return tr('This saved brief has no detailed priority explanations. Open Today and choose “Refresh brief” to prepare a brief with reasons and sources. I won’t invent reasons for an older summary.','Este resumen guardado no tiene explicaciones detalladas. Abra Hoy → “Refresh brief” para preparar uno con motivos y fuentes. No inventaré motivos para un resumen anterior.');
        return tr('You don’t have a saved brief for today yet, so there are no priorities to explain. Open Today and choose “Get today’s brief”. If you haven’t added a field, add its location and crop in Fields first.','Todavía no tiene un resumen guardado para hoy, así que no hay prioridades que explicar. Abra Hoy → “Get today’s brief”. Si falta una parcela, añada su ubicación y cultivo en Parcelas primero.');
      }
      const relevant=advisories.filter(item=>!field||item.fieldId===field.id).slice(0,3);
      if(!relevant.length)return tr(`Your saved brief has no priority for ${field.name}. That does not mean the field has no risks: a brief reviews a limited selection. Open Fields to review ${field.name}, or refresh the brief from Today.`, `Su resumen guardado no incluye una prioridad para ${field.name}. Esto no significa que no haya riesgos: el resumen revisa una selección limitada. Revise ${field.name} en Parcelas o actualice el resumen desde Hoy.`);
      const heading=tr(`Here’s why these priorities appear in your saved brief (${stamp(brief.createdAt)}):`,`Estos son los motivos de las prioridades de su resumen guardado (${stamp(brief.createdAt)}):`);
      return heading+'\n\n'+relevant.map((item,index)=>{
        const expired=!Number.isFinite(Date.parse(item.validUntil))||Date.parse(item.validUntil)<=Date.now();
        return `${index+1}. ${item.fieldName||tr('Your farm','Su finca')}: ${item.title}.\n${expired?tr('This saved advisory has expired or has no verified expiry—refresh before acting. ','Este aviso venció o no tiene vencimiento verificado; actualícelo antes de actuar. '):''}${item.whatChanged} ${item.whyItMatters} ${item.suggestedAction||''}\n${tr('Confidence','Confianza')}: ${item.confidence||tr('Not recorded','No registrada')}. ${tr('Valid until','Válido hasta')}: ${stamp(item.validUntil)}.`;
      }).join('\n\n');
    }
    if(/sensor|equipment|equipo/.test(q))return tr('Open Connected farm for private equipment records and manual or CSV sensor readings with Frontier Farm approval. Live sensor feeds, machinery control and WSU models are not connected. Imported readings are not live or calibrated advice.','Abra Connected farm para registros privados de equipos y lecturas manuales o CSV con aprobación de Frontier Farm. Los sensores en vivo, el control de maquinaria y los modelos WSU no están conectados. Las lecturas importadas no son datos en vivo ni recomendaciones calibradas.');
    if(/soil|suelo|market|precio|satellite|satélite|drought|sequía|smoke|humo|air quality/.test(q)){
      if(field)window.FarmerIntelligence?.select(field.id);else openPage('intelligence');
      return tr('I opened Data & Intelligence. Select your field to review sourced soil, market, air, water and satellite results, or explicitly refresh them. Each connection needs its own field permission; sources needing administrator keys show Setup needed. Satellite changes suggest scouting, not a diagnosis, and regional drought does not reveal your water allocation.','Abrí Datos e inteligencia. Elija su parcela para revisar fuentes de suelo, mercados, aire, agua y satélites, o actualizarlas. Cada conexión necesita permiso; algunas requieren claves del administrador. Un cambio satelital sugiere inspección, no un diagnóstico; la sequía regional no revela su asignación de agua.');
    }
    if(/task|tarea|due|pendient/.test(q)){
      const due=tasks.filter(task=>!task.done&&(!field||task.fieldId===field.id||(!task.fieldId&&task.place===field.name))&&(!task.date||task.date<=pacificDate()));
      return due.length?due.slice(0,8).map(task=>`${task.name} · ${task.date||tr('No date','Sin fecha')} ${task.time||''} · ${task.place||profile.farmName}`).join('\n'):tr('No unfinished tasks are recorded as due today for this selection.','No hay tareas pendientes para hoy en esta selección.');
    }
    if(/weather|forecast|wind|rain|temperature|tomorrow|alert|humidity|elevation|clima|viento|lluvia|temperatura|mañana|alerta|humedad|elevación/.test(q)||field){
      const selected=field||all.find(item=>item.dataConsent&&item.location);
      if(!selected)return tr('Add a field location and enable coordinate sharing in Fields to get field-specific weather and elevation.','Añada la ubicación de una parcela y permita compartir coordenadas para obtener clima y elevación.');
      const data=await window.FarmerFieldMap?.loadFieldData(selected.id);
      if(membership?.user?.id!==expected||!cloudEnabled)return '';
      const weather=data?.weather;
      if(!data||data.fieldId!==selected.id||!validForecast(weather))return tr(`${selected.name}: current field weather could not be verified. Open the field for retry and source status. I am not using an older saved response as current conditions.`,`${selected.name}: no se pudo verificar el clima actual. Abra la parcela para reintentar. No uso una respuesta anterior como condiciones actuales.`);
      const next=/tomorrow|mañana/.test(q),period=next?tomorrowPeriod(weather):forecastHours(weather)[0];
      if(!period)return tr('This forecast does not cover the requested time. Please refresh.','El pronóstico no cubre ese horario. Actualícelo.');
      const rain=rainText(period),humidity=period.relativeHumidity?.value,now=Date.now(),alertTime=Date.parse(data.alerts?.fetchedAt);
      const alertsFresh=['live','cached'].includes(data.alerts?.status)&&Number.isFinite(alertTime)&&alertTime<=now+60000&&now-alertTime<120000;
      const alerts=(data.alerts?.items||[]).filter(item=>Date.parse(item.effective)<=now&&Date.parse(item.expires)>now&&(!item.sent||Date.parse(item.sent)<=now+60000));
      const alertText=alertsFresh?(alerts.map(item=>item.headline||item.event).join('; ')||tr('none returned for this point at last check','ninguna devuelta para este punto en la última consulta')):tr('unavailable or outdated—not an all-clear','no disponibles o desactualizadas; no significa ausencia de riesgo');
      return `${selected.name}: ${tr(next?'Tomorrow forecast high':'Hourly forecast estimate',next?'Máxima prevista mañana':'Estimación horaria')} ${Math.round(period.temperature)}°F. ${period.shortForecast||''}. ${tr('Forecast wind','Viento previsto')}: ${period.windSpeed||'—'}. ${tr('Rain probability','Probabilidad de lluvia')}: ${rain||tr('unknown','desconocida')}. ${tr('Relative humidity','Humedad relativa')}: ${typeof humidity==='number'&&Number.isFinite(humidity)&&humidity>=0&&humidity<=100?humidity+'%':tr('unknown','desconocida')}. ${data.elevation?.status==='loaded'&&Number.isFinite(data.elevation.feet)?`${tr('USGS point elevation','Elevación USGS')}: ${Math.round(data.elevation.feet)} ft. `:''}${tr('Alerts','Alertas')}: ${alertText}. ${weather.source?.name||''} · ${forecastTimestamp(weather)}.${weather.stale||data.weatherStatus==='cached'?tr(' Saved forecast.',' Pronóstico guardado.'):''}${weather.source?.id==='open-meteo'?' Open-Meteo · CC BY 4.0 · units/wording adapted.':''} ${tr('Forecasts are not field measurements or safety clearance.','Los pronósticos no son mediciones de la parcela ni autorización de seguridad.')}`;
    }
    return tr('I didn’t find a supported question in that message. Ask about a saved brief, a field’s weather, or due tasks—for example, “What tasks are due today?” This chat uses recorded data and explainable rules. For an optional AI daily-message draft or read-only tool analysis, open Optional AI explanation on Today and approve a request.','No identifiqué una pregunta compatible. Pregunte por un resumen guardado, el clima de una parcela o tareas pendientes; por ejemplo, “¿Qué tareas están pendientes hoy?”. Este chat usa datos registrados y reglas explicables. Para un borrador diario con IA o un análisis con herramientas de solo lectura, abra «Optional AI explanation» en Hoy y apruebe una solicitud.');
  }
  function boot(){
    if(!membershipAllowsCore()||!cloudEnabled)return;
    if(bootOwner!==membership.user.id){bootOwner=membership.user.id;lastAutoAttempt=0;notified.clear();}
    get('welcomeSubtitle').textContent=tr('Your fields. Your tasks. Up to three priorities, with the evidence underneath.','Sus parcelas. Sus tareas. Hasta tres prioridades, con sus fuentes.');
    get('dailyBriefListenBtn').onclick=speakBrief;
    if(savedDailyBrief?.advisories)renderAdvisories(savedDailyBrief);
    renderProgress();checkSchedule();
  }
  const coverage=el('div','brief-coverage');coverage.id='briefCoverage';get('dailyBriefItems').after(coverage);
  const home=el('section','phase-home-tools');home.append(el('p','',tr('Start with your real fields.','Empiece con sus parcelas reales.')));const count=el('p','');count.id='homeFieldCount';home.append(count);
  const actions=el('div','phase-actions');actions.append(button('Manage fields',()=>openPage('fields'),'primary'),button('Add a task',()=>showModal()),button('Ask Farmer Daily',()=>openChat()));home.append(actions);get('dailyBriefPanel').after(home);
  // Keep optional community context below the field brief, with an explicit scope label.
  const context=el('details','community-context');context.append(el('summary','','Community forecast · not field-specific'));
  const signals=get('weatherSignal').parentElement;signals.before(context);context.append(signals);get('operationSignal').hidden=true;get('safetySignal').hidden=true;
  document.querySelector('.tomorrow-card').prepend(el('p','community-scope','Community forecast · not field-specific'));
  get('settingsPage').append(get('planPanel'));
  const schedule=el('section','schedule-panel');schedule.append(el('h2','','Daily brief schedule'));
  const description=el('p','');description.id='scheduleDescription';const permission=button('Enable browser notifications',async()=>{if(!('Notification'in window))return;await Notification.requestPermission();renderProgress();});permission.id='notificationPermissionBtn';const notice=el('p','');notice.id='notificationStatus';
  schedule.append(description,el('p','','This in-app schedule runs while open or on return after your chosen time. Separately consented SMS/WhatsApp schedules are managed in Messages & WhatsApp below; check its server connection status. Closed-app browser push is not configured.'),button('Edit schedule and language',openProfileEditor),permission,notice);get('settingsPage').append(schedule);
  const intelligence=el('section','page placeholder');intelligence.id='intelligencePage';intelligence.append(el('p','eyebrow','YOUR FARMER DAILY'),el('h1','','Data & Intelligence'),el('p','','Live farm connections and product maturity are different. Only sources actually loaded for your fields are counted below.'));
  const statuses=el('div','farm-data-status');statuses.id='farmDataStatus';const rows=el('div','intelligence-rows');rows.id='intelligenceRows';const dev=el('a','secondary','Developer build status');dev.id='devStatusLink';dev.href='/dev/status';dev.hidden=true;
  intelligence.append(statuses,el('h2','','Build roadmap'),el('p','','Not started → Building → Working → Validated. Validation means tests passed, not guaranteed live data or delivery.'),rows,dev);get('settingsPage').before(intelligence);
  window.PhaseOne={boot,renderAdvisories,renderProgress,checkSchedule,answer,speakBrief};
  window.addEventListener('field-data-updated',renderProgress);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){renderProgress();checkSchedule();if(savedDailyBrief?.advisories)renderAdvisories(savedDailyBrief);}});
  setInterval(()=>{if(!document.hidden){checkSchedule();if(savedDailyBrief?.advisories)renderAdvisories(savedDailyBrief);}},60000);
})();
