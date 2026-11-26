'use strict';

// Private records stay in the authenticated owner's existing state document.
// This module prepares internal work; it never sends messages or controls equipment.
(() => {
  const get = id => document.getElementById(id);
  const key = name => `farmerDaily${name}`;
  const read = name => { try { const value=JSON.parse(localStorage.getItem(key(name))||'[]'); return Array.isArray(value)?value:[]; } catch { return []; } };
  const getFields = () => read('Fields');
  const getObservations = () => read('Observations');
  const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
  const stamp = () => new Date().toISOString();
  const nextDate = date => {const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+1)).toISOString().slice(0,10);};
  const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Date not recorded';
  let busyPhoto=false, preparing=false, applying=false, photoGeneration=0, jobGeneration=0;

  function element(tag, className, text) {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!==undefined)node.textContent=String(text);
    return node;
  }
  function button(text, className, action) {
    const node=element('button',className,text);node.type='button';node.onclick=action;return node;
  }
  function owner() {
    if(!membershipAllowsCore()||!cloudEnabled||!profile||localStorage.getItem('farmerDailyCloudOwner')!==membership?.user?.id)throw new Error('Reconnect your account before changing farm records.');
    return membership.user.id;
  }
  function assertOwner(expected) {if(owner()!==expected)throw new Error('Your signed-in account changed. Reload before saving.');}
  function notice(message, target='workspaceMessage') {get(target).textContent=message;}
  function report(error, target='workspaceMessage') {notice(error.message||'Could not save. Please retry.',target);}
  function event(action, detail) {return {at:stamp(),action,detail};}

  // Check the complete payload before any local change, then roll back if the
  // browser's own storage quota fails. Leave room for the server timestamp.
  function commit(changes, expected=owner()) {
    assertOwner(expected);
    if(['observations','jobs','jobEvents'].some(name=>Object.hasOwn(changes,name))&&!membershipAllowsPremium())throw new Error('Frontier Farm approval is required for this feature. Your records were not changed.');
    const candidate={...collectCloudState(),...changes};
    if(new TextEncoder().encode(JSON.stringify(candidate)).length>500*1024)throw new Error('Your farm records are nearly full (512 KB). Export records and remove older photos or notes before adding more. Nothing was changed.');
    const entries=Object.entries(changes).map(([name,value])=>[farmStorageKeys[name],JSON.stringify(value)]);
    const previous=entries.map(([name])=>[name,localStorage.getItem(name)]);
    try{for(const [name,value] of entries)localStorage.setItem(name,value);}
    catch{for(const [name,value] of previous){try{value===null?localStorage.removeItem(name):localStorage.setItem(name,value);}catch{}}throw new Error('Device storage is full or unavailable. Nothing was saved; export or free storage and retry.');}
    if(changes.tasks)tasks=changes.tasks;
    if(changes.jobs)agentJobs=changes.jobs;
    if(changes.jobEvents)jobEvents=changes.jobEvents;
    renderTasks();render();
    saveCloudState();
  }
  function saved(message, target='workspaceMessage') {
    notice(`${message} Device copy saved; sync status is shown above.`,target);
    toast(message);
  }
  function fieldOptions(select, all=false, preferred='') {
    select.replaceChildren();
    if(all){const option=element('option','', 'All saved fields');option.value='';select.append(option);}
    for(const field of getFields()){const option=element('option','',field.name);option.value=field.id;select.append(option);}
    if(preferred&&Array.from(select.options).some(option=>option.value===preferred))select.value=preferred;
  }

  function openField(id) {
    if(!requireCore())return;
    try{owner();if(!window.FarmerFieldMap)throw new Error('The field location editor has not loaded. Refresh the app before editing fields.');const field=getFields().find(item=>item.id===id);get('fieldForm').reset();get('fieldError').textContent='';
      get('fieldId').value=field?.id||'';get('fieldName').value=field?.name||'';get('fieldCrop').value=field?.crop||'';get('fieldStage').value=field?.stage||'';get('fieldAcres').value=field?.acres??'';
      window.FarmerFieldMap?.open(field);get('fieldDialogTitle').textContent=field?'Edit field':'Add a field';window.FarmerFieldFlow?.open(field);get('fieldDialog').showModal();get('fieldName').focus();
    }catch(error){report(error);}
  }
  async function updateFieldContext(id, patch) {
    const expected=owner(),allowed=new Set(['contextConsent','satelliteConsent','landsatConsent','marketReportId','marketLabel']);
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(name=>!allowed.has(name)))throw new Error('Choose valid field intelligence preferences.');
    const fields=getFields(),existing=fields.find(field=>field.id===id);
    if(!existing)throw new Error('Choose a current saved field.');
    for(const name of ['contextConsent','satelliteConsent','landsatConsent'])if(Object.hasOwn(patch,name)&&typeof patch[name]!=='boolean')throw new Error('Choose whether to allow each data source.');
    if(Object.hasOwn(patch,'marketReportId')&&(typeof patch.marketReportId!=='string'||!/^(?:[0-9]{1,8})?$/.test(patch.marketReportId)))throw new Error('Enter a numeric USDA report ID or leave it blank.');
    if(Object.hasOwn(patch,'marketLabel')&&(typeof patch.marketLabel!=='string'||patch.marketLabel.length>120))throw new Error('Use a market label of at most 120 characters.');
    if(patch.contextConsent===true&&!existing.location)throw new Error('Save a field location before enabling farm context.');
    if((patch.satelliteConsent===true||patch.landsatConsent===true)&&!existing.boundary)throw new Error('Draw or import a field boundary before enabling satellite analysis.');
    commit({fields:fields.map(field=>field.id===id?{...field,...patch}:field)},expected);
    const synced=await saveCloudState();assertOwner(expected);
    return {synced};
  }
  function removeField(field) {
    if(!confirm(`Remove ${field.name} from active fields? Existing observations and tasks will remain as historical records.`))return;
    try{commit({fields:getFields().filter(item=>item.id!==field.id)});saved('Field removed; its recorded history was retained.');}catch(error){report(error);}
  }
  get('fieldForm').onsubmit=e=>{
    e.preventDefault();
    try{
      const fields=getFields(),id=get('fieldId').value,existing=fields.find(item=>item.id===id);
      const name=get('fieldName').value.trim(),crop=get('fieldCrop').value.trim(),stage=get('fieldStage').value.trim(),acres=get('fieldAcres').value===''?null:Number(get('fieldAcres').value);
      if(!name||!crop)throw new Error('Enter the actual field name and crop or use.');
      if(!existing&&fields.length>=50)throw new Error('You can save up to 50 fields.');
      if(acres!==null&&(!Number.isFinite(acres)||acres<=0||acres>1000000))throw new Error('Enter a valid acreage or leave it blank.');
      if(fields.some(item=>item.id!==id&&item.name.toLowerCase()===name.toLowerCase()))throw new Error('A field with that name already exists. Edit it or use a different name.');
      if(!window.FarmerFieldMap)throw new Error('Refresh the app to load the field location editor. Nothing was changed.');
      const field={...existing,id:existing?.id||uid('field'),name,crop,stage,acres,createdAt:existing?.createdAt||stamp(),...window.FarmerFieldMap.readValue()};
      for(const property of ['location','boundary','variety','plantingDate','bloomDate','transplantDate'])if(field[property]===null||field[property]==='')delete field[property];
      commit({fields:existing?fields.map(item=>item.id===id?field:item):[...fields,field]});
      get('fieldDialog').close();saved(existing?'Field changes saved on this device.':'Field saved on this device.');window.FarmerFieldFlow?.saved(field);
      if(field.location&&field.dataConsent)window.FarmerFieldMap?.loadFieldData(field.id);
    }catch(error){get('fieldError').textContent=error.message;window.FarmerFieldFlow?.failure(error.message);}
  };
  get('addFieldBtn').onclick=()=>openField();get('cancelFieldBtn').onclick=()=>get('fieldDialog').close();

  function openObservation(fieldId) {
    if(!requirePremium())return;
    try{owner();if(!getFields().length){openPage('fields');notice('Add your first field before recording an observation.');openField();return;}
      photoGeneration++;get('observationForm').reset();get('observationError').textContent='';fieldOptions(get('observationField'),false,fieldId);
      get('observationBackdrop').classList.add('open');get('observationText').focus();
    }catch(error){report(error);}
  }

  async function photoThumbnail(file) {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw new Error('Choose a JPEG, PNG, or WebP photo up to 10 MB.');
    const url=URL.createObjectURL(file),image=new Image();
    try{
      image.src=url;await image.decode();
      if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>40000000)throw new Error('This image is too large to process. Choose a smaller photo.');
      const canvas=document.createElement('canvas');
      for(const maximum of [960,720,480,320]){
        const scale=Math.min(1,maximum/Math.max(image.naturalWidth,image.naturalHeight));
        canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
        const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        for(const quality of [.78,.58,.38]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<=80*1024)return data;}
      }
      throw new Error('This photo cannot fit the record size limit. Try a smaller image.');
    }finally{URL.revokeObjectURL(url);}
  }
  get('observationForm').onsubmit=async e=>{
    e.preventDefault();if(busyPhoto)return;busyPhoto=true;get('saveObservationBtn').disabled=true;get('observationError').textContent='';
    const generation=photoGeneration;
    for(const id of ['observationField','observationText','observationPhoto'])get(id).disabled=true;
    try{
      const expected=owner(),field=getFields().find(item=>item.id===get('observationField').value),note=get('observationText').value.trim();
      if(!field||!note)throw new Error('Choose a saved field and describe your observation.');
      if(getObservations().length>=200)throw new Error('You can save up to 200 observations. Export and remove older records first.');
      const file=get('observationPhoto').files[0],photo=file?await photoThumbnail(file):undefined;
      if(generation!==photoGeneration)return;
      assertOwner(expected);
      const currentField=getFields().find(item=>item.id===field.id);
      if(!currentField)throw new Error('That field was removed. Choose a current field.');
      const observation={id:uid('note'),fieldId:field.id,field:currentField.name,note,hasPhoto:!!photo,createdAt:stamp(),...(photo?{photo}:{})};
      commit({observations:[observation,...getObservations()]},expected);hideObservation();saved('Observation saved.');
      window.FarmerFocusedViews?.reveal('#observationList',{scroll:true});
    }catch(error){if(generation===photoGeneration)get('observationError').textContent=error.message||'The photo could not be read. Try another image.';}
    finally{busyPhoto=false;get('saveObservationBtn').disabled=false;for(const id of ['observationField','observationText','observationPhoto'])get(id).disabled=false;}
  };
  get('addObservationBtn').onclick=()=>openObservation();
  get('observationSearch').oninput=renderObservations;

  function followUp(observation) {
    if(!requirePremium())return;
    try{
      if(tasks.some(task=>task.observationId===String(observation.id))){toast('A follow-up task already exists.');return;}
      const task={id:uid('task'),observationId:String(observation.id),fieldId:observation.fieldId||'',name:`Follow up: ${observation.note.slice(0,100)}`,place:observation.field,date:pacificDate(),time:'',status:'Choose time',done:false,createdAt:stamp()};
      commit({tasks:[...tasks,task]});saved('Follow-up task created.');
    }catch(error){report(error);}
  }
  function removeObservation(observation) {
    if(!requirePremium())return;
    if(!confirm('Delete this observation and its saved photo? Existing follow-up tasks will remain.'))return;
    try{commit({observations:getObservations().filter(item=>String(item.id)!==String(observation.id))});saved('Observation and photo removed from current records.');}catch(error){report(error);}
  }
  function renderFields() {
    window.FarmerFieldFlow?.resetConfirmation();
    const fields=getFields();get('fieldGrid').replaceChildren();get('fieldCount').textContent=`${fields.length} of 50 fields`;
    if(!fields.length)get('fieldGrid').append(element('p','workspace-empty','No fields yet. Add the fields you actually manage; no names, acreage, or crop conditions are estimated.'));
    for(const field of fields){
      const card=element('article','real-field'),content=element('div','field-content');
      content.append(element('h2','',field.name),element('p','',field.crop),element('p','workspace-note',`${field.stage||'Stage not recorded'} · ${field.acres==null?'Acreage not recorded':`${field.acres} acres`}`));
      content.append(element('p',`field-location-state${field.location?'':' field-location-missing'}`,field.location?(field.boundary?'Boundary recorded':'Point location recorded'):'Add location to connect field weather'));
      const actions=element('div','workspace-actions');actions.append(button('View conditions','secondary',()=>window.FarmerFieldMap?.select(field.id)));if(membershipAllowsPremium())actions.append(button('Log observation','secondary',()=>openObservation(field.id)));actions.append(button('Edit','text-btn',()=>openField(field.id)),button('Remove','text-btn',()=>removeField(field)));content.append(actions);card.append(content);get('fieldGrid').append(card);
    }
    window.FarmerFieldMap?.render(fields);
  }
  function renderObservations() {
    const target=get('observationList');target.replaceChildren();if(!membershipAllowsPremium()||!cloudEnabled)return;
    const search=get('observationSearch').value.trim().toLowerCase(),fields=getFields();
    const observations=getObservations().filter(item=>`${item.field} ${item.note} ${fields.find(field=>field.id===item.fieldId)?.crop||''}`.toLowerCase().includes(search));
    if(!observations.length)target.append(element('p','workspace-empty',search?'No observations match your search.':'No observations yet. Record what you actually notice in a field.'));
    for(const observation of observations){
      const card=element('article','observation-card'),header=element('div','observation-heading');
      header.append(element('h3','',observation.field||'Historical observation'),element('small','',dateLabel(observation.createdAt)));card.append(header,element('p','observation-note',observation.note));
      if(typeof observation.photo==='string'&&observation.photo.length<=80*1024&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(observation.photo)){
        const image=element('img','observation-photo');image.src=observation.photo;image.alt=`Saved observation in ${observation.field}`;image.loading='lazy';card.append(image);
      }else if(observation.hasPhoto)card.append(element('p','workspace-note','The earlier app recorded a photo selection but did not retain the image. Add a new observation to save a photo.'));
      const actions=element('div','workspace-actions'),task=tasks.find(item=>item.observationId===String(observation.id));
      const follow=button(task?(task.done?'Follow-up completed':'Follow-up task created'):'Create follow-up task','secondary observation-followup',()=>followUp(observation));follow.disabled=!!task;
      actions.append(follow,button('Delete note and photo','text-btn',()=>removeObservation(observation)));card.append(actions);target.append(card);
    }
  }

  async function fingerprint(value) {
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function contextKey() {
    return fingerprint({fields:getFields(),observations:getObservations().map(({photo,...note})=>note),work:tasks.map(({id,fieldId,date,time,done,workType})=>({id,fieldId,date,time,done,workType})),locationId:profile?.locationId,wind:profile?.wind,priorityField:profile?.priorityField});
  }
  function forecastKey(forecast,date) {
    return fingerprint({source:forecast?.source?.id,locationId:forecast?._locationId,hours:(forecast?.hourly||[]).filter(hour=>Number.isFinite(Date.parse(hour.startTime))&&pacificDate(hour.startTime)===date).map(hour=>({start:hour.startTime,end:hour.endTime,wind:hour.windSpeed,rain:hour.probabilityOfPrecipitation?.value??null}))});
  }
  function openJob(type='plan',instructions='') {
    if(!requirePremium())return;
    try{owner();jobGeneration++;get('jobForm').reset();get('jobType').value=type;get('jobInstructions').value=instructions.slice(0,1000);get('jobDate').value=nextDate(pacificDate());get('jobDate').min=pacificDate();get('jobDate').max=nextDate(pacificDate());fieldOptions(get('jobField'),true);get('jobError').textContent='';jobModal.classList.add('open');get('jobType').focus();}catch(error){report(error,'plannerMessage');}
  }
  get('jobForm').onsubmit=async e=>{
    e.preventDefault();if(preparing)return;preparing=true;get('prepareJobBtn').disabled=true;get('jobError').textContent='';
    const generation=jobGeneration;
    try{
      const expected=owner(),type=get('jobType').value,detail=get('jobInstructions').value.trim(),date=get('jobDate').value,id=uid('job'),originalContext=await contextKey();
      const allFields=getFields(),selected=get('jobField').value,fields=selected?allFields.filter(field=>field.id===selected):allFields;
      if(date!==pacificDate()&&date!==nextDate(pacificDate()))throw new Error('Choose today or tomorrow in Pacific time.');
      if(agentJobs.filter(job=>job.status!=='dismissed').length>=50)throw new Error('Dismiss older job cards before preparing more work.');
      let plan,draft,title,weatherKey;
      if(type==='plan'){
        if(!fields.length)throw new Error('Add a real field in your notebook first.');
        const unplanned=fields.filter(field=>!tasks.some(task=>task.fieldId===field.id&&task.date===date&&task.workType==='inspection'));
        if(!unplanned.length)throw new Error('Inspections already exist for these fields on that date. Edit the existing tasks instead of creating duplicates.');
        if(!activeForecast())await loadForecast();assertOwner(expected);
        const forecast=activeForecast();plan=FarmerWorkPlan.buildPlan({fields:unplanned,observations:getObservations(),profile,forecast,date,id});weatherKey=await forecastKey(forecast,date);title='Field inspection plan';
        if(unplanned.length!==fields.length)plan.notices.push('Fields with an inspection already recorded for this date were excluded. Their existing tasks are unchanged.');
      }else if(type==='tasks'){
        if(fields.length!==1)throw new Error('Choose one saved field for your manual task.');
        if(!detail)throw new Error('Enter the exact title of the task to create.');
        plan={id,forDate:date,locationId:profile.locationId,createdAt:stamp(),notices:['Manual task entered by you. No weather assessment or automatic assignment is implied.'],items:[{id:`${id}-item-1`,fieldId:fields[0].id,name:detail.slice(0,200),place:fields[0].name,date,time:'',reason:'Task title supplied by you. Choose a time after reviewing conditions.',done:false}]};title='Manual field task';
      }else if(type==='message'){
        title='Crew-message draft';draft=`${profile.farmName} — ${date}\n${detail||'Please review your assigned work and current field conditions.'}\nFields: ${fields.map(field=>field.name).join(', ')||'No fields recorded'}.\nThis is a draft; no message has been sent.`;
      }else throw new Error('Choose a supported job type.');
      assertOwner(expected);
      if(originalContext!==await contextKey())throw new Error('Your farm records changed while preparing this preview. Please prepare it again.');
      if(generation!==jobGeneration)return;
      const job={id,type,title,detail,status:'prepared',createdAt:stamp(),contextKey:originalContext,...(weatherKey?{weatherKey}:{}),...(plan?{plan}:{}),...(draft?{draft}:{})};
      commit({jobs:[job,...agentJobs.filter(job=>job.status!=='dismissed')],jobEvents:[event('Prepared for review',title),...jobEvents].slice(0,100)},expected);
      jobModal.classList.remove('open');openPage('jobs');saved('Preview ready. No tasks were created and nothing was sent.','plannerMessage');
    }catch(error){if(generation===jobGeneration)get('jobError').textContent=error.message;}
    finally{preparing=false;get('prepareJobBtn').disabled=false;}
  };

  async function approveJob(id) {
    if(!requirePremium())return;
    if(applying)return;applying=true;
    try{
      const expected=owner(),job=agentJobs.find(item=>String(item.id)===String(id));
      if(!job||job.status!=='prepared')throw new Error('This job is no longer waiting for approval.');
      if(job.contextKey!==await contextKey())throw new Error('Your field records, existing work, location, or preferences changed. Dismiss this preview and prepare a new one.');
      assertOwner(expected);
      if(agentJobs.find(item=>item.id===job.id)?.status!=='prepared')throw new Error('This job has already changed. Review its current status.');
      if(job.draft){
        commit({jobs:agentJobs.map(item=>item.id===job.id?{...item,status:'draft',approvedAt:stamp()}:item),jobEvents:[event('Draft approved — not sent',job.title),...jobEvents].slice(0,100)});
        saved('Draft approved. No messaging provider is connected; nothing was sent.','plannerMessage');return;
      }
      if(!job.plan?.items?.length)throw new Error('This older job has no reviewable output. Prepare a new plan.');
      if(job.plan.forDate<pacificDate())throw new Error('This plan is for a past day. Prepare a new plan.');
      if(job.plan.source){
        const age=Date.now()-Date.parse(job.plan.source.fetchedAt);
        if(!Number.isFinite(age)||age<0||age>=6*60*60*1000||job.plan.locationId!==profile.locationId)throw new Error('This forecast has expired or your location changed. Refresh weather and prepare a new plan.');
        const latest=activeForecast();
        if(!latest)throw new Error('Refresh weather before approving this plan.');
        if(job.weatherKey!==await forecastKey(latest,job.plan.forDate))throw new Error('The forecast changed since this preview. Prepare a new plan so its times reflect the latest weather.');
      }
      assertOwner(expected);
      if(job.contextKey!==await contextKey())throw new Error('Your farm records changed during approval. Prepare a new plan.');
      if(agentJobs.find(item=>item.id===job.id)?.status!=='prepared')throw new Error('This job has already changed. Review its current status.');
      const nowTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
      if(job.plan.items.some(item=>item.date===pacificDate()&&item.time&&item.time<nowTime))throw new Error('A proposed work time has already passed. Prepare a new plan before approving.');
      const additions=job.plan.items.filter(item=>!tasks.some(task=>task.planItemId===item.id)).map(item=>({...item,id:uid('task'),planItemId:item.id,jobId:job.id,status:item.time?'Planned':'Choose time',done:false,createdAt:stamp()}));
      if(!additions.length)throw new Error('These tasks already exist. Nothing was duplicated.');
      commit({tasks:[...tasks,...additions],jobs:agentJobs.map(item=>item.id===job.id?{...item,status:'applied',approvedAt:stamp(),taskIds:additions.map(task=>task.id)}:item),jobEvents:[event('Plan approved and tasks created',`${additions.length} tasks from ${job.title}`),...jobEvents].slice(0,100)});
      saved(`${additions.length} tasks created. Track completion in Tasks; no field work has been performed automatically.`,'plannerMessage');
    }catch(error){report(error,'plannerMessage');}
    finally{applying=false;}
  }
  function undoJob(id) {
    if(!requirePremium())return;
    const job=agentJobs.find(item=>item.id===id);if(!job||job.status!=='applied')return;
    const removable=tasks.filter(task=>task.jobId===id&&!task.done);
    if(!removable.length){notice('There are no unfinished tasks to undo. Completed records are retained.','plannerMessage');return;}
    if(!confirm(`Remove ${removable.length} unfinished tasks created by this plan? Completed work records will remain.`))return;
    try{commit({tasks:tasks.filter(task=>task.jobId!==id||task.done),jobs:agentJobs.map(item=>item.id===id?{...item,status:'undone',undoneAt:stamp()}:item),jobEvents:[event('Undid unfinished plan tasks',`${removable.length} removed; completed work retained`),...jobEvents].slice(0,100)});saved('Unfinished tasks removed. Completed work was kept.','plannerMessage');}catch(error){report(error,'plannerMessage');}
  }
  function dismissJob(id) {
    if(!requirePremium())return;
    try{commit({jobs:agentJobs.map(job=>String(job.id)===String(id)?{...job,status:'dismissed'}:job),jobEvents:[event('Dismissed job card','Existing tasks and completed work were retained.'),...jobEvents].slice(0,100)});}catch(error){report(error,'plannerMessage');}
  }
  function renderJobs() {
    const list=get('jobList');list.replaceChildren();if(!membershipAllowsPremium()||!cloudEnabled)return;
    const visible=agentJobs.filter(job=>job.status!=='dismissed'),waiting=visible.filter(job=>job.status==='prepared').length;get('jobSummary').textContent=`${waiting} ${waiting===1?'preview':'previews'} waiting for review`;get('jobCount').textContent=waiting;
    if(!visible.length)list.append(element('p','workspace-empty','No plans yet. Prepare work using your saved fields and review the exact output here.'));
    for(const job of visible){
      const card=element('article','job-card workspace-job');card.dataset.job=job.id;
      const content=element('div','job-content');content.append(element('h2','',job.title||'Earlier job'),element('p','',job.detail||''));
      if(job.plan){
        content.append(element('p','workspace-note',`For ${job.plan.forDate} · all times Pacific · prepared ${dateLabel(job.plan.createdAt)}`));
        if(job.plan.source){
          const source=job.plan.source,credit=element('p','workspace-note'),link=element('a','',source.name);
          // Do not trust a persisted URL: rebuild a known provider link.
          link.href=source.id==='open-meteo'?'https://open-meteo.com/':'https://www.weather.gov/';link.target='_blank';link.rel='noopener noreferrer';
          credit.append(link,document.createTextNode(` · retrieved ${dateLabel(source.fetchedAt)}${source.cached?' · saved forecast':''}`));
          if(source.id==='open-meteo'){const license=element('a','','CC BY 4.0');license.href='https://creativecommons.org/licenses/by/4.0/';license.target='_blank';license.rel='noopener noreferrer';credit.append(document.createTextNode(' · '),license);}content.append(credit);
        }
        for(const warning of job.plan.notices||[])content.append(element('p','plan-notice',warning));
        const proposed=element('ol','plan-items');for(const item of job.plan.items||[]){const row=element('li','');row.append(element('b','',`${item.time||'Unscheduled'} · ${item.name}`),element('p','',item.reason));proposed.append(row);}content.append(proposed);
      }else if(job.draft){const draft=element('textarea','crew-draft');draft.readOnly=true;draft.value=job.draft;draft.setAttribute('aria-label','Unsent crew-message draft');content.append(draft);}
      else content.append(element('p','plan-notice','Earlier prototype record: no verifiable output was saved. Prepare a new job to create actual work.'));
      const linked=tasks.filter(task=>task.jobId===job.id),completed=linked.filter(task=>task.done).length;
      const labels={prepared:'Preview only — awaiting approval',applied:`Tasks created · ${completed} of ${linked.length} completed`,undone:`Unfinished tasks undone · ${completed} completed records retained`,draft:'Draft approved — not sent'};
      content.append(element('p','job-progress',labels[job.status]||'Earlier prototype record'));
      const actions=element('div','workspace-actions');
      if(job.status==='prepared'&&(job.plan||job.draft))actions.append(button(job.draft?'Approve draft (not send)':`Approve & create ${job.plan.items.length} tasks`,'primary job-approve',()=>approveJob(job.id)));
      if(job.status==='applied'&&linked.some(task=>!task.done))actions.append(button('Undo unfinished tasks','secondary job-undo',()=>undoJob(job.id)));
      actions.append(button('Dismiss card','text-btn job-dismiss',()=>dismissJob(job.id)));content.append(actions);card.append(content);list.append(card);
    }
    const history=get('jobActivity');history.replaceChildren();
    if(!jobEvents.length)history.append(element('p','workspace-empty','No planning actions recorded.'));
    for(const record of jobEvents.slice(0,12)){const row=element('div','activity-row');row.append(element('b','',record.action),element('small','',record.detail),element('span','',dateLabel(record.at)));history.append(row);}
  }
  function renderInsights() {
    const target=get('recordInsights');target.replaceChildren();
    for(const [title,detail] of [[`${getFields().length} saved fields`,'Field names, crop stages, and acreage are entered by you.'],[`${getObservations().length} observations`,'Recorded notes and photos; not automated diagnoses.'],[`${tasks.filter(task=>!task.done).length} unfinished tasks`,`${tasks.filter(task=>task.done).length} tasks marked complete by you. No time, yield, or water savings are inferred.`]]){const row=element('article',''),copy=element('div','');copy.append(element('b','',title),element('p','',detail));row.append(copy);target.append(row);}
  }
  function render() {
    if(!membershipAllowsCore()||!cloudEnabled){for(const id of ['fieldGrid','observationList','jobList','recordInsights'])get(id).replaceChildren();window.FarmerFieldMap?.render([]);window.FarmerIntelligence?.clear();window.ConnectedFarm?.clear();return;}
    renderFields();renderObservations();renderJobs();renderInsights();
    window.FarmerIntelligence?.render();
    window.ConnectedFarm?.render();
  }
  const cancelPreparation=()=>{jobGeneration++;};
  window.FarmerWorkspace={getFields,getObservations,render,renderJobs,openField,openObservation,openJob,approveJob,dismissJob,cancelPhoto:()=>{photoGeneration++;},cancelPreparation,updateFieldContext};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){hideObservation();cancelPreparation();jobModal.classList.remove('open');}});
  render();
})();
