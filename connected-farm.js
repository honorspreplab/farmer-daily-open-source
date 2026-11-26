'use strict';

// Private owner-scoped operations stay in memory. Opening another app page does
// not contact equipment, license providers, messaging services, or this API.
(() => {
  const get=id=>document.getElementById(id);
  const node=(tag,text,className)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(className)item.className=className;return item;};
  const button=(text,handler,primary=false)=>{const item=node('button',text,primary?'primary':'secondary');item.type='button';if(handler)item.onclick=handler;return item;};
  const fields=()=>window.FarmerWorkspace?.getFields()||[];
  const fieldName=id=>fields().find(item=>item.id===id)?.name||(id?'Removed field':'Whole farm');
  const owner=()=>typeof membershipAllowsPremium==='function'&&membershipAllowsPremium()&&typeof cloudEnabled!=='undefined'&&cloudEnabled&&membership?.user?.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;
  const active=()=>get('connectedPage')?.classList.contains('active');
  const value=id=>get(id)?.value.trim()||'';
  const timestamp=text=>Number.isFinite(Date.parse(text))?new Date(text).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Date not recorded';
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const note=text=>node('p',text,'cf-note');
  const empty=text=>node('p',text,'cf-empty');
  const arrays=['equipment','readings','knowledge','workflows','events'];
  const workflowActions=new Set(['proposeWorkflow','executeWorkflow','cancelWorkflow','deleteWorkflow']);
  let mounted=false,cacheOwner=null,operations=null,revision=null,busy=false,controller=null,generation=0,fieldSignature='',csvPreview=null;

  function setStatus(text){if(get('connectedStatus'))get('connectedStatus').textContent=text;}
  function formFeedback(id,text,error=false){const item=get(id);if(!item)return;item.textContent=text;item.classList.toggle('cf-warning',error);item.dataset.state=error?'error':'info';}
  function feedbackElement(id,text){const item=node('p',text,'cf-form-status');item.id=id;item.setAttribute('role','status');item.setAttribute('aria-live','polite');item.tabIndex=-1;return item;}
  function pair(dl,label,text){const row=node('div');row.append(node('dt',label),node('dd',text));dl.append(row);}
  function input(id,label,type='text',options={}){
    const wrap=node('label',label),item=node(type==='textarea'?'textarea':'input');item.id=id;
    if(type!=='textarea')item.type=type;
    if(options.required)item.required=true;if(options.maxLength)item.maxLength=options.maxLength;if(options.placeholder)item.placeholder=options.placeholder;
    if(options.min!==undefined)item.min=String(options.min);if(options.max!==undefined)item.max=String(options.max);if(options.step)item.step=options.step;
    if(options.help)wrap.append(node('small',options.help));wrap.append(item);return wrap;
  }
  function select(id,label,options){const wrap=node('label',label),item=node('select');item.id=id;for(const [value,text]of options){const option=node('option',text);option.value=value;item.append(option);}wrap.append(item);return wrap;}
  function fieldSelect(id,required=false){const wrap=select(id,required?'Field (required)':'Field (optional)',[]);wrap.querySelector('select').dataset.cfFields=required?'required':'optional';wrap.querySelector('select').required=required;return wrap;}
  function submit(form,id,text){const item=button(text,null,true);item.id=id;item.type='submit';item.dataset.cfWrite='true';form.append(item);return item;}
  function panel(parent,id,title,description){const section=node('section',undefined,'cf-section');section.id=id;section.append(node('h3',title),note(description));parent.append(section);return section;}
  function editor(parent,id,title){const details=node('details');details.id=id;details.append(node('summary',title));const form=node('form',undefined,'cf-form');details.append(form);parent.append(details);return form;}
  function recordCard(title,kind){const card=node('article',undefined,'cf-card');card.append(node('h4',title));if(kind)card.append(node('span',kind,'cf-badge'));return card;}
  function clear(){generation++;controller?.abort();controller=null;operations=null;revision=null;busy=false;cacheOwner=null;csvPreview=null;fieldSignature='';get('connectedFarm')?.remove();mounted=false;window.CalendarConnections?.clear();}

  function syncFields(){
    for(const element of get('connectedFarm')?.querySelectorAll('[data-cf-fields]')||[]){const previous=element.value;element.replaceChildren();const first=node('option',element.dataset.cfFields==='required'?'Choose a saved field':'Whole farm / no field');first.value='';element.append(first);for(const field of fields()){const option=node('option',field.name);option.value=field.id;element.append(option);}if(fields().some(field=>field.id===previous))element.value=previous;}
    const taskSelect=get('cfWorkflowTask');if(taskSelect){const previous=taskSelect.value;taskSelect.replaceChildren();const option=node('option','Choose an unfinished task');option.value='';taskSelect.append(option);for(const task of typeof tasks!=='undefined'?tasks:[]){if(task.done)continue;const option=node('option',`${task.name} · ${task.date||'No date'}`);option.value=String(task.id);taskSelect.append(option);}taskSelect.value=previous;}
    if(get('cfReadingsSetup'))get('cfReadingsSetup').hidden=fields().length>0;
  }
  function updateButtons(){
    const connected=!!owner()&&owner()===cacheOwner&&!!operations;
    for(const item of get('connectedFarm')?.querySelectorAll('button[data-cf-write]')||[])item.disabled=busy||!connected||item.dataset.cfBlocked==='true';
    if(get('cfRefresh'))get('cfRefresh').disabled=busy||!owner();
    if(get('cfImportReadings'))get('cfImportReadings').disabled=busy||!connected||!csvPreview;
    get('connectedFarm')?.setAttribute('aria-busy',String(busy));
  }
  function validateEnvelope(data){if(!data||!data.operations||!(data.revision===null||typeof data.revision==='string'&&data.revision)||arrays.some(key=>!Array.isArray(data.operations[key])))throw new Error('The operations service returned an unexpected response. Refresh the app and try again.');}
  async function request(action,payload,feedbackId){
    const expected=owner();if(!expected||expected!==cacheOwner||busy)return null;
    const report=(text,error=false)=>{setStatus(text);if(feedbackId)formFeedback(feedbackId,text,error);};
    if(action&&!operations){report('Reload private records before saving. Your form entries have been kept.',true);return null;}
    const ticket=generation,originalFields=JSON.stringify(fields().map(field=>field.id)),localController=new AbortController();controller=localController;busy=true;updateButtons();
    const valid=()=>generation===ticket&&owner()===expected&&cacheOwner===expected&&originalFields===JSON.stringify(fields().map(field=>field.id));
    const timer=setTimeout(()=>localController.abort(),25000);
    try{
      if(action&&!workflowActions.has(action)&&typeof saveCloudState==='function'){if(!await saveCloudState())throw new Error('Cloud sync is paused. Reconnect before changing operations.');if(!valid())return null;}
      const response=await fetch('/api/farm-operations',{method:action?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:localController.signal,headers:{Accept:'application/json','X-Farmer-Account-Id':expected,...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify({action,payload,revision})}:{})});
      if(!valid())return null;
      if(response.status===401||response.status===403||response.type==='opaqueredirect'){const error=new Error(response.status===403?'Frontier Farm approval is required. Refresh your account to check access.':'Your sign-in expired. Sign in again to reconnect your private farm.');error.status=response.status||401;throw error;}
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The operations service returned an unexpected response. Refresh the app and try again.');
      const data=await response.json();if(!valid())return null;
      if(!response.ok){const error=new Error(typeof data.error==='string'?data.error.slice(0,400):`Farm operations are unavailable (${response.status}). Please retry.`);error.status=response.status;throw error;}
      validateEnvelope(data);operations=data.operations;revision=data.revision;renderLists();report(action?'Saved securely to your private farm.':'Private records loaded. Manual and CSV readings are not live sensor connections.');
      if(!action)for(const id of ['cfReadingStatus','cfCsvStatus'])if(get(id)?.dataset.state==='error')formFeedback(id,'Private records loaded. Review your entries before saving or importing.');
      return data;
    }catch(error){
      if(!valid())return null;
      if([401,403].includes(error.status)){clear();mount();get('cfGate').hidden=false;get('cfGate').textContent=error.message;get('cfContent').hidden=true;if(workflowActions.has(action))throw error;return null;}
      revision=null;operations=null;renderLists();
      const message=error.name==='AbortError'?'The request timed out. Reload records before retrying: a save may have completed.':`${error.message} Your form entries have been kept. Reload private records to check what saved before trying again.`;
      report(message,true);if(!feedbackId){formFeedback('cfReadingStatus',message,true);formFeedback('cfCsvStatus',message,true);}if(workflowActions.has(action))throw error;return null;
    }finally{clearTimeout(timer);if(controller===localController){controller=null;busy=false;updateButtons();}}
  }
  function cancelEdit(form,id,detailsId){form.reset();if(get(id))get(id).value='';if(get(detailsId))get(detailsId).open=false;}
  function deleteButton(name,action,id){const item=button(`Remove ${name}`,()=>{if(confirm(`Remove ${name} from your private farm? This cannot be undone.`))request(action,{id});});item.dataset.cfWrite='true';return item;}
  function equipmentForm(parent){
    const form=editor(parent,'cfEquipmentEditor','Add or edit equipment');form.id='cfEquipmentForm';const hidden=node('input');hidden.type='hidden';hidden.id='cfEquipmentId';form.append(hidden);
    const grid=node('div',undefined,'cf-grid');grid.append(input('cfEquipmentName','Equipment name','text',{required:true,maxLength:120}),select('cfEquipmentKind','Equipment type',[['irrigation','Irrigation'],['tractor','Tractor'],['sprayer','Sprayer'],['sensor','Sensor'],['other','Other']]),fieldSelect('cfEquipmentField'),input('cfEquipmentIrrigation','Irrigation type (optional)','text',{maxLength:80,placeholder:'e.g. Drip'}),input('cfEquipmentService','Next service date (optional)','date'));form.append(grid,input('cfEquipmentNotes','Equipment notes (optional)','textarea',{maxLength:2000,help:'No API keys, passwords or access tokens.'}));submit(form,'cfSaveEquipment','Save equipment');
    form.onsubmit=async event=>{event.preventDefault();const result=await request('saveEquipment',{...(value('cfEquipmentId')?{id:value('cfEquipmentId')}:{}),name:value('cfEquipmentName'),kind:value('cfEquipmentKind'),fieldId:value('cfEquipmentField'),irrigationType:value('cfEquipmentIrrigation'),serviceDate:value('cfEquipmentService'),notes:value('cfEquipmentNotes')});if(result)cancelEdit(form,'cfEquipmentId','cfEquipmentEditor');};
    parent.append(Object.assign(node('div'),{id:'cfEquipmentList'}));
  }
  const metrics={soil_moisture:{unit:'percent',min:0,max:100,label:'Soil moisture'},air_temperature:{unit:'F',min:-100,max:160,label:'Air temperature'},rainfall:{unit:'mm',min:0,max:2000,label:'Rainfall'},battery:{unit:'percent',min:0,max:100,label:'Battery'}};
  function validateReading(reading,index){
    const prefix=Number.isInteger(index)?`Row ${index+1}: `:'',metric=typeof reading.metric==='string'&&Object.hasOwn(metrics,reading.metric)?metrics[reading.metric]:null;
    if(!fields().some(field=>field.id===reading.fieldId))throw new Error(prefix+'choose a saved field ID from this account.');
    if(typeof reading.sensorId!=='string'||!reading.sensorId.trim()||reading.sensorId.length>120||/[\u0000-\u001f]/.test(reading.sensorId))throw new Error(prefix+'sensor name must be 1–120 characters without control characters.');
    if(!metric||reading.unit!==metric.unit)throw new Error(prefix+'use an allowed metric and its unit: soil_moisture/percent, air_temperature/F, rainfall/mm or battery/percent.');
    if(typeof reading.value!=='number'||!Number.isFinite(reading.value)||reading.value<metric.min||reading.value>metric.max)throw new Error(prefix+`${metric.label} must be between ${metric.min} and ${metric.max} ${metric.unit}.`);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(reading.observedAt)||!Number.isFinite(Date.parse(reading.observedAt)))throw new Error(prefix+'use an ISO observation timestamp with timezone, for example YYYY-MM-DDTHH:mm:ss-07:00.');
    if(new Date(`${reading.observedAt.slice(0,10)}T12:00:00Z`).toISOString().slice(0,10)!==reading.observedAt.slice(0,10))throw new Error(prefix+'observation date does not exist.');
    if(Date.parse(reading.observedAt)>Date.now()||Date.parse(reading.observedAt)<0)throw new Error(prefix+'observation timestamps must be between 1970 and now.');
    return reading;
  }
  function parseCsv(text){
    if(typeof text!=='string'||text.length>60000)throw new Error('CSV must be 60 KB or less.');
    const rows=[];let row=[],cell='',quoted=false,closed=false;
    for(let i=0;i<text.length;i++){const char=text[i];if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;continue;}if(char==='"'){if(cell||closed)throw new Error('Invalid CSV quotation.');quoted=true;}else if(char===','){row.push(cell);cell='';closed=false;}else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value.trim()))rows.push(row);row=[];cell='';closed=false;if(rows.length>101)throw new Error('Import up to 100 readings at a time.');}else{if(closed&&!/\s/.test(char))throw new Error('Unexpected text after a CSV quote.');if(!closed)cell+=char;}}
    if(quoted)throw new Error('CSV contains an unclosed quote.');row.push(cell);if(row.some(value=>value.trim()))rows.push(row);
    const header=rows.shift()?.map(value=>value.trim().replace(/^\uFEFF/,''));if(JSON.stringify(header)!==JSON.stringify(['fieldId','sensorId','metric','unit','value','observedAt']))throw new Error('CSV header must be fieldId,sensorId,metric,unit,value,observedAt.');
    if(!rows.length||rows.length>100)throw new Error('Include between 1 and 100 readings.');
    return rows.map((cells,index)=>{if(cells.length!==6)throw new Error(`Row ${index+1}: expected 6 columns.`);const [fieldId,sensorId,metric,unit,raw,observedAt]=cells.map(value=>value.trim());if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))throw new Error(`Row ${index+1}: value must be a number.`);return validateReading({fieldId,sensorId,metric,unit,value:Number(raw),observedAt,source:'csv'},index);});
  }
  function download(text,name,type='text/plain'){if(!owner()||owner()!==cacheOwner)return;const url=URL.createObjectURL(new Blob([text],{type})),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function invalidatePreview(){csvPreview=null;get('cfCsvPreview')?.replaceChildren();updateButtons();}
  function localDateInput(date=new Date()){
    const pad=number=>String(number).padStart(2,'0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function readingDateToIso(text,now=Date.now()){
    const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text||'');
    if(!parts)throw new Error('Choose the date and time when you took the measurement.');
    const [year,month,day,hour,minute,second]=parts.slice(1).map(value=>Number(value||0));
    const date=new Date(year,month-1,day,hour,minute,second);
    if(year<1970||date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute||date.getSeconds()!==second)throw new Error('Choose a real date and time in your device timezone. Some times do not exist when daylight saving starts.');
    if(date.getTime()>now)throw new Error('The measurement time is in the future. Choose when you actually took the reading.');
    // A local picker has no offset selector. Do not silently select one of two
    // observations in a repeated clock hour when daylight saving ends.
    for(const delta of [-86400000,86400000]){
      const offset=new Date(date.getTime()+delta).getTimezoneOffset(),alternate=new Date(date.getTime()+(offset-date.getTimezoneOffset())*60000);
      if(alternate.getTime()!==date.getTime()&&alternate.getFullYear()===year&&alternate.getMonth()===month-1&&alternate.getDate()===day&&alternate.getHours()===hour&&alternate.getMinutes()===minute&&alternate.getSeconds()===second)throw new Error('This clock time occurs twice when daylight saving ends. Import this reading by CSV with its correct timezone offset so the observation time is not guessed.');
    }
    return date.toISOString();
  }
  function readingMetricHelp(){
    const metric=metrics[value('cfReadingMetric')];if(!metric)return;
    const control=get('cfReadingValue');control.min=String(metric.min);control.max=String(metric.max);
    get('cfReadingRange').textContent=`${metric.label}: enter ${metric.min} to ${metric.max} ${metric.unit==='percent'?'%':metric.unit==='F'?'°F':'mm'}. Only enter an actual measurement.`;
  }
  function readingsForm(parent){
    const optional=node('div',undefined,'cf-empty');optional.id='cfReadingsOptional';optional.append(node('strong','No sensors or measurements? You can skip this whole section.'),note('Readings are real measurements from a thermometer, rain gauge or other instrument. Notes, tasks, weather and satellite tools work without them. Do not make up readings to finish setup.'));parent.append(optional);
    const setup=node('div',undefined,'cf-warning');setup.id='cfReadingsSetup';setup.append(node('p','To save a measurement, first add the field where it was taken. You can skip this if you have no measurements.'),button('Add a field',()=>{openPage('fields');window.FarmerWorkspace?.openField();}));parent.append(setup);
    const form=editor(parent,'cfReadingEditor','Record a reading');form.id='cfReadingForm';form.noValidate=true;
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'your device timezone';
    form.append(note('Have one real measurement? Enter it here. No CSV file or connected sensor is needed.'),fieldSelect('cfReadingField',true),input('cfReadingSensor','Instrument or source name','text',{required:true,maxLength:100,placeholder:'For example: handheld thermometer'}),select('cfReadingMetric','Measurement',[['soil_moisture','Soil moisture (%)'],['air_temperature','Air temperature (°F)'],['rainfall','Rainfall (mm)'],['battery','Battery (%)']]),input('cfReadingValue','Measured value','number',{required:true,step:'any'}));
    const range=note('');range.id='cfReadingRange';form.append(range,input('cfReadingDate','Date and time measured','datetime-local',{required:true,help:`Time zone: ${zone} (this device). Choose when you took the measurement, not when you upload it.`}));
    const nowButton=button('Use current time',()=>{get('cfReadingDate').value=localDateInput();formFeedback('cfReadingStatus','Current time selected. Use this only if you just took the measurement. Nothing has been saved.');});nowButton.id='cfReadingNow';form.append(nowButton);
    form.querySelector('#cfReadingMetric').addEventListener('change',readingMetricHelp);
    submit(form,'cfSaveReading','Save measured reading');form.append(feedbackElement('cfReadingStatus','Choose a field and enter a real measurement, then save.'));
    const reload=button('Reload private records',()=>request(undefined,undefined,'cfReadingStatus'));reload.id='cfReadingReload';form.append(reload);
    form.onsubmit=async event=>{event.preventDefault();try{
      if(!fields().length)throw new Error('Add a field before saving a reading, or skip readings if you have no measurements.');
      if(!value('cfReadingField'))throw new Error('Choose the field where you took this measurement.');
      if(!value('cfReadingSensor'))throw new Error('Enter the instrument or source name, such as a handheld thermometer.');
      if(!value('cfReadingValue')||get('cfReadingValue').validity.badInput)throw new Error('Enter the measured number. A blank value is not a zero reading.');
      const metric=value('cfReadingMetric'),reading=validateReading({fieldId:value('cfReadingField'),sensorId:value('cfReadingSensor'),metric,unit:metrics[metric]?.unit,value:Number(value('cfReadingValue')),observedAt:readingDateToIso(value('cfReadingDate')),source:'manual'});
      formFeedback('cfReadingStatus','Saving your reading…');const result=await request('importReadings',{readings:[reading]},'cfReadingStatus');
      if(result)formFeedback('cfReadingStatus',result.result?.added>0?'Reading saved to your private farm. It appears in Saved readings below.':'This exact reading was already saved. No duplicate was created.');
    }catch(error){formFeedback('cfReadingStatus',error.message,true);}};
    const csv=editor(parent,'cfCsvEditor','Import readings from CSV');csv.id='cfCsvForm';csv.noValidate=true;
    csv.append(node('strong','Optional: for importing several real measurements together.'),note('CSV is a spreadsheet saved as a .csv file. If you do not already have measurements, skip this. For a single reading, use Record a reading above.'));
    const steps=node('ol',undefined,'cf-csv-steps');for(const text of ['Download the blank template and open it in your spreadsheet app. Keep the column headings unchanged.','Add one real measurement per row. Use the field IDs and column guide below. Do not fill in example or invented measurements.','Save or export the spreadsheet as a CSV (.csv) file, then choose that file here.','Click Preview CSV. Check the fields, numbers and times, then click Import reviewed readings. Previewing alone does not save anything.'])steps.append(node('li',text));csv.append(steps);
    const guide=node('details');guide.id='cfCsvGuide';guide.append(node('summary','What goes in each spreadsheet column?'));const definitions=node('dl',undefined,'cf-facts');
    for(const [name,description]of [['fieldId','Copy the ID beside your saved field below. This links the reading to the right field.'],['sensorId','The instrument or source name, such as your handheld thermometer.'],['metric','Use air_temperature, soil_moisture, rainfall or battery.'],['unit','Use F for air_temperature, percent for soil_moisture/battery, or mm for rainfall.'],['value','The actual measured number, with no unit text.'],['observedAt','The measurement time with a timezone. Format example only: 2026-10-01T09:30:00-07:00. Use your real date, time and correct offset; Z means UTC.']])pair(definitions,name,description);guide.append(definitions,note('Up to 100 rows and 60 KB per file. Upload only readings you own. No live sensor connection is created.'));csv.append(guide);
    csv.append(button('Download blank CSV template',()=>download('fieldId,sensorId,metric,unit,value,observedAt\r\n','farmer-daily-readings-template.csv','text/csv')),input('cfCsvFile','Choose CSV file (optional)','file'),input('cfCsvText','CSV text (filled automatically when you choose a file)','textarea',{maxLength:60000,help:'You can paste CSV here instead of choosing a file. If this looks confusing, use Record a reading above.'}));
    const ids=node('div',undefined,'cf-note');ids.id='cfFieldIds';csv.append(node('h4','Your saved field IDs'),ids);const previewButton=button('Preview CSV',()=>{try{csvPreview=parseCsv(value('cfCsvText'));const box=get('cfCsvPreview');box.replaceChildren(node('h4',`${csvPreview.length} readings ready for review`));for(const reading of csvPreview){box.append(note(`${fieldName(reading.fieldId)} · ${reading.sensorId} · ${metrics[reading.metric].label}: ${reading.value} ${reading.unit} · ${timestamp(reading.observedAt)}`));}updateButtons();formFeedback('cfCsvStatus','Preview ready. Nothing has been saved yet. Check the readings, then choose Import reviewed readings.');}catch(error){invalidatePreview();formFeedback('cfCsvStatus',error.message,true);}});previewButton.id='cfPreviewCsv';csv.append(previewButton,Object.assign(node('div'),{id:'cfCsvPreview'}));
    submit(csv,'cfImportReadings','Import reviewed readings');csv.append(feedbackElement('cfCsvStatus','Choose a file or paste CSV text, then click Preview CSV to enable import.'));
    csv.append(button('Reload private records',()=>request(undefined,undefined,'cfCsvStatus')));
    csv.onsubmit=async event=>{event.preventDefault();if(!csvPreview){formFeedback('cfCsvStatus','Preview the CSV first. Nothing has been imported.',true);return;}formFeedback('cfCsvStatus','Importing your reviewed readings…');const result=await request('importReadings',{readings:csvPreview},'cfCsvStatus');if(result){const added=result.result?.added||0,duplicates=result.result?.duplicates||0;csv.reset();invalidatePreview();formFeedback('cfCsvStatus',added?`${added} ${added===1?'reading':'readings'} imported to your private farm.${duplicates?` ${duplicates} already saved; no duplicates created.`:''}`:`No new readings added: all ${duplicates} were already saved.`);}};
    csv.querySelector('#cfCsvText').oninput=()=>{invalidatePreview();formFeedback('cfCsvStatus','CSV text changed. Preview it again before importing.');};const file=csv.querySelector('#cfCsvFile');file.accept='.csv,text/csv';file.onchange=async()=>{invalidatePreview();const selected=file.files?.[0],expected=owner(),ticket=generation;if(!selected)return;if(selected.size>60000){formFeedback('cfCsvStatus','CSV must be 60 KB or less.',true);file.value='';return;}try{const text=await selected.text();if(ticket!==generation||owner()!==expected)return;get('cfCsvText').value=text;formFeedback('cfCsvStatus','File loaded on this device. Click Preview CSV. Nothing has been saved yet.');}catch{formFeedback('cfCsvStatus','Could not read this CSV file. Choose the file again.',true);}};
    parent.append(node('h4','Saved readings'));
    parent.append(Object.assign(node('div'),{id:'cfReadingList'}));
  }
  function knowledgeForm(parent){
    const form=editor(parent,'cfKnowledgeEditor','Save a farm note, SOP or manual excerpt');form.id='cfKnowledgeForm';const hidden=node('input');hidden.id='cfKnowledgeId';hidden.type='hidden';form.append(hidden,input('cfKnowledgeTitle','Title','text',{required:true,maxLength:150}),select('cfKnowledgeKind','Record type',[['note','Farm note'],['sop','Standard operating procedure'],['manual','Manual excerpt']]),fieldSelect('cfKnowledgeField'),input('cfKnowledgeText','Text','textarea',{required:true,maxLength:8000,help:'Private text only, up to 8,000 characters. No passwords or API keys. Only upload material you have permission to use.'}));submit(form,'cfSaveKnowledge','Save private knowledge');form.onsubmit=async event=>{event.preventDefault();const result=await request('saveKnowledge',{...(value('cfKnowledgeId')?{id:value('cfKnowledgeId')}:{}),title:value('cfKnowledgeTitle'),kind:value('cfKnowledgeKind'),fieldId:value('cfKnowledgeField'),text:value('cfKnowledgeText')});if(result)cancelEdit(form,'cfKnowledgeId','cfKnowledgeEditor');};
    const search=input('cfKnowledgeSearch','Search your saved text','search',{maxLength:100,help:'Exact keyword matching in your saved records—not an AI answer or a diagnosis.'});search.className='cf-search';search.querySelector('input').oninput=renderKnowledge;parent.append(search,Object.assign(node('div'),{id:'cfKnowledgeList'}));
  }
  function renderEquipment(){const target=get('cfEquipmentList');if(!target)return;target.replaceChildren();if(!operations?.equipment.length){target.append(empty('No equipment recorded yet. Add your own equipment above.'));return;}for(const item of operations.equipment){const card=recordCard(item.name,'Equipment register · not remotely connected'),dl=node('dl',undefined,'cf-facts');pair(dl,'Type',item.kind);pair(dl,'Field',fieldName(item.fieldId));if(item.irrigationType)pair(dl,'Irrigation type',item.irrigationType);if(item.serviceDate)pair(dl,'Next service date',item.serviceDate);card.append(dl);if(item.serviceDate&&item.serviceDate<=today())card.append(node('p','Service is due according to your entered date. Review your equipment manual.','cf-warning'));if(item.notes)card.append(node('p',item.notes,'cf-pre'));const actions=node('div',undefined,'cf-actions');actions.append(button('Edit equipment',()=>{get('cfEquipmentId').value=item.id;for(const [id,key]of [['cfEquipmentName','name'],['cfEquipmentKind','kind'],['cfEquipmentField','fieldId'],['cfEquipmentIrrigation','irrigationType'],['cfEquipmentService','serviceDate'],['cfEquipmentNotes','notes']])get(id).value=item[key]||'';get('cfEquipmentEditor').open=true;get('cfEquipmentName').focus();}),deleteButton('equipment','deleteEquipment',item.id));card.append(actions);target.append(card);}}
  function renderReadings(){
    const target=get('cfReadingList');if(!target)return;target.replaceChildren();if(!operations){target.append(empty('Private records are not loaded. Reload private records to check your saved readings.'));return;}if(!operations.readings.length){target.append(empty('No measured readings saved. Manual entry and CSV import are available; automatic sensor feeds are not connected.'));return;}
    const sorted=[...operations.readings].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    for(const reading of sorted.slice(0,100)){const card=recordCard(`${metrics[reading.metric]?.label||reading.metric}: ${reading.value} ${reading.unit}`,reading.source==='csv'?'CSV import · not live':'Manual reading · not live');card.append(note(`${fieldName(reading.fieldId)} · ${reading.sensorId}`),note(`Observed ${timestamp(reading.observedAt)}`));if(!Number.isFinite(Date.parse(reading.observedAt))||Date.now()-Date.parse(reading.observedAt)>86400000)card.append(node('p','Older than 24 hours. This reading does not establish current field conditions.','cf-warning'));target.append(card);}
    if(sorted.length>100)target.append(note(`Showing the latest 100 of ${sorted.length} readings. Your full history is included in the private data export.`));
    const details=node('details');details.id='cfReadingBatches';details.append(node('summary','Manage saved reading batches'),note('Remove a mistaken import before recording corrected measurements, or export and remove old batches to make room. Removal is permanent; previously downloaded copies are not removed.'));
    const batches=new Map();for(const reading of operations.readings){if(!batches.has(reading.batchId))batches.set(reading.batchId,[]);batches.get(reading.batchId).push(reading);}
    for(const [batchId,readings]of [...batches].reverse()){const card=recordCard(`${readings.length} ${readings.length===1?'reading':'readings'} · ${readings[0].source==='csv'?'CSV import':'Manual entry'}`);card.append(note(`Saved ${timestamp(readings[0].receivedAt)} · ${[...new Set(readings.map(reading=>fieldName(reading.fieldId)))].join(', ')}`));const remove=button('Remove this batch',()=>{if(confirm(`Permanently remove these ${readings.length} readings saved ${timestamp(readings[0].receivedAt)}? Export a copy first if needed. This cannot be undone.`))request('deleteReadingsBatch',{batchId});});remove.dataset.cfWrite='true';remove.dataset.batchId=batchId;card.append(remove);details.append(card);}target.append(details);
  }
  function renderKnowledge(){const target=get('cfKnowledgeList');if(!target)return;target.replaceChildren();const terms=value('cfKnowledgeSearch').toLocaleLowerCase().split(/\s+/).filter(Boolean),items=(operations?.knowledge||[]).filter(item=>terms.every(term=>`${item.title} ${item.text}`.toLocaleLowerCase().includes(term)));if(!items.length){target.append(empty(terms.length?'No saved record contains all of those words. Nothing has been inferred.':'No private farm knowledge saved yet.'));return;}for(const item of items){const card=recordCard(item.title,item.kind),details=node('details');details.append(node('summary','Read saved source text'),node('p',item.text,'cf-pre'));card.append(note(`${fieldName(item.fieldId)} · Saved ${timestamp(item.updatedAt||item.createdAt)}`),details);const actions=node('div',undefined,'cf-actions');actions.append(button('Edit record',()=>{for(const [id,key]of [['cfKnowledgeId','id'],['cfKnowledgeTitle','title'],['cfKnowledgeKind','kind'],['cfKnowledgeField','fieldId'],['cfKnowledgeText','text']])get(id).value=item[key]||'';get('cfKnowledgeEditor').open=true;get('cfKnowledgeTitle').focus();}),deleteButton('record','deleteKnowledge',item.id));card.append(actions);target.append(card);}}

  function workflowForm(parent){
    const form=editor(parent,'cfWorkflowEditor','Prepare a job for review');form.id='cfWorkflowForm';form.append(select('cfWorkflowType','What should the app do?',[['create_task','Create a farm task'],['reschedule_task','Reschedule an existing task'],['prepare_record','Prepare a farm record'],['draft_message','Prepare a message draft — never send']]));
    const taskWrap=select('cfWorkflowTask','Existing task',[]);taskWrap.id='cfWorkflowTaskWrap';form.append(taskWrap);
    const fieldWrap=fieldSelect('cfWorkflowField');fieldWrap.id='cfWorkflowFieldWrap';form.append(fieldWrap);
    const titleWrap=input('cfWorkflowTitle','Title','text',{maxLength:200});titleWrap.id='cfWorkflowTitleWrap';form.append(titleWrap);
    const dateWrap=input('cfWorkflowDate','New task date (Pacific time)','date');dateWrap.id='cfWorkflowDateWrap';form.append(dateWrap);
    const timeWrap=input('cfWorkflowTime','New task time (optional · Pacific time)','time');timeWrap.id='cfWorkflowTimeWrap';form.append(timeWrap);
    const recipientWrap=input('cfWorkflowRecipient','Recipient email (draft only)','email',{maxLength:200,help:'Enter one email address for your private draft. No email, SMS or WhatsApp message will be sent.'});recipientWrap.id='cfWorkflowRecipientWrap';form.append(recipientWrap);
    const textWrap=input('cfWorkflowText','Record or message text','textarea',{maxLength:8000});textWrap.id='cfWorkflowTextWrap';form.append(textWrap);
    submit(form,'cfProposeWorkflow','Prepare review — do not run yet');form.querySelector('#cfWorkflowType').onchange=workflowFields;
    form.onsubmit=async event=>{event.preventDefault();const kind=value('cfWorkflowType'),payload={kind};if(kind==='create_task'){Object.assign(payload,{fieldId:value('cfWorkflowField'),title:value('cfWorkflowTitle'),date:value('cfWorkflowDate'),time:value('cfWorkflowTime')});}else if(kind==='reschedule_task'){Object.assign(payload,{taskId:value('cfWorkflowTask'),date:value('cfWorkflowDate'),time:value('cfWorkflowTime')});}else if(kind==='prepare_record'){Object.assign(payload,{fieldId:value('cfWorkflowField'),title:value('cfWorkflowTitle'),text:value('cfWorkflowText')});}else{Object.assign(payload,{recipient:value('cfWorkflowRecipient'),title:value('cfWorkflowTitle'),text:value('cfWorkflowText')});}const result=await workflowRequest('proposeWorkflow',payload);if(result){form.reset();workflowFields();setStatus('Proposal saved for review. Nothing has run. Read the exact change and approve it below.');get('cfWorkflowList').scrollIntoView({block:'start'});}};
    parent.append(Object.assign(node('div'),{id:'cfWorkflowList'}));
  }
  function workflowFields(){const type=value('cfWorkflowType'),task=type==='create_task'||type==='reschedule_task';for(const [id,visible]of [['Task',type==='reschedule_task'],['Field',type==='create_task'||type==='prepare_record'],['Title',type!=='reschedule_task'],['Date',task],['Time',task],['Recipient',type==='draft_message'],['Text',!task]]){const wrap=get(`cfWorkflow${id}Wrap`);if(wrap){wrap.hidden=!visible;const control=wrap.querySelector('input,select,textarea');control.disabled=!visible;control.required=visible&&['Task','Title','Date','Recipient','Text'].includes(id);}}}
  async function workflowRequest(action,payload){
    if(typeof window.runServerWorkflowRequest!=='function'){setStatus('Reload the app to load the secure workflow sync controls. No action was run.');return null;}
    try{const result=await window.runServerWorkflowRequest(()=>request(action,payload));syncFields();return result;}catch(error){
      if(!owner()){clear();render();get('cfGate').replaceChildren(node('p','The workflow result could not be confirmed. A server action may have completed. Reload the app to synchronize before running it again.'),button('Reload app to reconnect',()=>location.reload()));get('cfGate').hidden=false;get('cfContent').hidden=true;}
      else setStatus(error.message||'Could not synchronize this workflow. Reload records before trying again.');return null;
    }
  }
  function readable(object){const names={kind:'Action',fieldName:'Field',fieldId:'Field',taskId:'Task',name:'Task name',title:'Title',text:'Text',date:'Date (Pacific time)',time:'Time (Pacific time)',recipient:'Intended recipient',message:'Outcome'},kinds={create_task:'Create a farm task',reschedule_task:'Reschedule a farm task',prepare_record:'Save a private farm record',draft_message:'Save a private message draft — not send'};return Object.entries(object||{}).filter(([key,value])=>!['id','createdAt','updatedAt','existingTask','taskId'].includes(key)&&!(key==='fieldId'&&object.fieldName)&&value!==undefined&&value!==null&&value!=='').map(([key,value])=>`${names[key]||key}: ${key==='kind'?(kinds[value]||value):key==='fieldId'?fieldName(value):typeof value==='object'?readable(value):value}`).join('\n');}
  function calendar(workflow){
    const data=workflow.result?.task||{},date=data.date,time=data.time;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||time&&!/^\d{2}:\d{2}$/.test(time))return;
    const escape=value=>String(value||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
    // Explicit Pacific daylight/standard rules make the file portable to
    // calendars that do not ship the IANA timezone database (valid since 2007).
    const zone=['BEGIN:VTIMEZONE','TZID:America/Los_Angeles','BEGIN:DAYLIGHT','DTSTART:20070311T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','TZOFFSETFROM:-0800','TZOFFSETTO:-0700','TZNAME:PDT','END:DAYLIGHT','BEGIN:STANDARD','DTSTART:20071104T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','TZOFFSETFROM:-0700','TZOFFSETTO:-0800','TZNAME:PST','END:STANDARD','END:VTIMEZONE'];
    const rows=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Farmer Daily//Approved Farm Task//EN',...(time?zone:[]),'BEGIN:VEVENT',`UID:${escape(workflow.id)}@farmerdaily`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,time?`DTSTART;TZID=America/Los_Angeles:${date.replace(/-/g,'')}T${time.replace(':','')}00`:`DTSTART;VALUE=DATE:${date.replace(/-/g,'')}`,`SUMMARY:${escape(data.name||workflow.title)}`,`DESCRIPTION:${escape('Approved Farmer Daily task. '+(data.place||'Whole farm'))}`,'END:VEVENT','END:VCALENDAR',''];
    const encoder=new TextEncoder(),fold=text=>{const lines=[];let line='',bytes=0;for(const char of text){const size=encoder.encode(char).length;if(bytes+size>75){lines.push(line);line=' ';bytes=1;}line+=char;bytes+=size;}lines.push(line);return lines.join('\r\n');};
    download(rows.map(fold).join('\r\n'),'farmer-daily-approved-task.ics','text/calendar');
  }
  function renderWorkflows(){const target=get('cfWorkflowList');if(!target)return;target.replaceChildren();if(!operations?.workflows.length){target.append(empty('No jobs prepared. Choose an action above, review the exact change, then approve it.'));return;}for(const workflow of operations.workflows){const card=recordCard(workflow.title||workflow.preview?.title||workflow.kind,workflow.status),preview=node('div',undefined,'cf-review');preview.append(node('h4','Exact change for your review'));if(workflow.preview?.existingTask)preview.append(note('Before'),node('p',readable(workflow.preview.existingTask),'cf-pre'));preview.append(note('After / requested action'),node('p',readable(workflow.preview),'cf-pre'));card.append(note(`Prepared ${timestamp(workflow.createdAt)} · Approval expires ${timestamp(workflow.expiresAt)}`),preview);if(workflow.kind==='draft_message')card.append(note('Creates a private draft only. This app does not send a message or contact the recipient.'));if(workflow.kind==='prepare_record')card.append(note('Saves a farm record only. This does not certify regulatory compliance.'));
      if(workflow.status==='pending'){const expired=!Number.isFinite(Date.parse(workflow.expiresAt))||Date.parse(workflow.expiresAt)<=Date.now();const label=node('label',undefined,'cf-approve-label'),check=node('input');check.type='checkbox';check.id=`cfApproveCheck-${workflow.id}`;check.disabled=expired;label.append(check,node('span',expired?'This proposal expired. Prepare a new proposal to review current conditions.':'I reviewed this exact change and approve this action.'));const actions=node('div',undefined,'cf-actions'),approve=button(workflow.kind==='draft_message'?'Approve and save draft':'Approve and run',async()=>{if(!check.checked||Date.parse(workflow.expiresAt)<=Date.now())return;const result=await workflowRequest('executeWorkflow',{id:workflow.id});if(result)setStatus(result.result?.message||(workflow.kind==='draft_message'?'Draft saved privately. No message was sent.':'Approved action completed. Check its result below.'));},true);approve.dataset.cfWrite='true';approve.dataset.cfBlocked='true';approve.dataset.workflowId=workflow.id;check.onchange=()=>{approve.dataset.cfBlocked=String(!check.checked||expired);updateButtons();};const cancel=button('Cancel proposal',()=>workflowRequest('cancelWorkflow',{id:workflow.id}));cancel.dataset.cfWrite='true';actions.append(approve,cancel);card.append(label,actions);}
      if(workflow.result){card.append(node('h4','Recorded result'));if(workflow.result.message)card.append(node('p',workflow.result.message));const result=workflow.result.record||workflow.result.draft;if(result)card.append(node('p',readable(result),'cf-pre'));if(workflow.result.task){const task=workflow.result.task;card.append(node('p',readable({name:task.name,fieldName:task.place||'Whole farm',date:task.date,time:task.time||'Not specified'}),'cf-pre'));}}
      if(workflow.status==='executed'&&workflow.kind==='draft_message')card.append(button('Download message draft',()=>download(`${workflow.result?.draft?.title||workflow.preview?.title||''}\nTo: ${workflow.result?.draft?.recipient||workflow.preview?.recipient||''}\n\n${workflow.result?.draft?.text||workflow.preview?.text||''}`,'farmer-daily-message-draft.txt')));
      if(workflow.status==='executed'&&['create_task','reschedule_task'].includes(workflow.kind))card.append(button('Download calendar file (Pacific time)',()=>calendar(workflow)),note('Downloading a calendar file does not connect or update your calendar. Import it yourself; avoid duplicate imports.'));
      if(['executed','cancelled'].includes(workflow.status)){const remove=button('Remove saved workflow record',async()=>{if(!confirm('Permanently remove this saved workflow and any private record or message draft it contains? Download a copy first if needed. This cannot be undone. Any created or rescheduled task stays in your task list.'))return;const result=await workflowRequest('deleteWorkflow',{id:workflow.id});if(result)setStatus(result.result?.message||'Saved workflow removed. Tasks were not deleted or executed.');});remove.dataset.cfWrite='true';remove.dataset.deleteWorkflowId=workflow.id;card.append(remove);}
      target.append(card);
    }}
  function renderEvents(){const target=get('cfEventList');if(!target)return;target.replaceChildren();const events=operations?.events||[];if(!events.length){target.append(empty('No operation events recorded.'));return;}const labels={saveEquipment:'Equipment saved',deleteEquipment:'Equipment removed',importReadings:'Readings imported',deleteReadingsBatch:'Reading batch removed',saveKnowledge:'Farm knowledge saved',deleteKnowledge:'Farm knowledge removed',proposeWorkflow:'Job proposed for review',executeWorkflow:'Approved job executed',cancelWorkflow:'Job proposal cancelled',deleteWorkflow:'Saved workflow record removed'};const list=node('ol',undefined,'cf-events');for(const event of [...events].reverse().slice(0,100))list.append(node('li',`${timestamp(event.occurredAt||event.at||event.createdAt)} · ${event.message||labels[event.action]||event.type||event.action||'Operation recorded'}`));target.append(list);}
  function renderLists(){renderEquipment();renderReadings();renderKnowledge();renderWorkflows();renderEvents();updateButtons();}
  function mount(){
    const page=get('connectedPage');if(mounted||!page)return;mounted=true;
    const root=node('section',undefined,'connected-farm');root.id='connectedFarm';root.setAttribute('aria-labelledby','connectedFarmHeading');const heading=node('h2','Frontier Farm · Connected work');heading.id='connectedFarmHeading';root.append(heading,note('Phase 4: your equipment, measured readings and private knowledge. Phase 5: jobs that run only after your approval. No payment is needed; Frontier Farm requires admin approval.'));
    const gate=empty('Sign in with an approved Frontier Farm account to use these private tools.');gate.id='cfGate';root.append(gate);
    const content=node('div');content.id='cfContent';content.hidden=true;const status=node('p','','cf-status');status.id='connectedStatus';status.setAttribute('role','status');content.append(status);const refresh=button('Reload private records',()=>request());refresh.id='cfRefresh';content.append(refresh,note('Operations are stored under your signed-in Azure account. These records are not copied to browser storage or shared with app admins. Downloaded exports are your responsibility.'));
    equipmentForm(panel(content,'cfEquipmentSection','Equipment and irrigation','Keep a register and service dates. Recording irrigation equipment does not operate it or prescribe water amounts.'));
    readingsForm(panel(content,'cfReadingsSection','Measured sensor readings','Record real observations or import a CSV. Source and observation time stay attached; readings are not a calibrated agronomic recommendation.'));
    knowledgeForm(panel(content,'cfKnowledgeSection','Your farm knowledge','Save and search your own notes, SOPs and manual excerpts. Search results quote your records; they do not invent advice.'));
    workflowForm(panel(content,'cfWorkflowSection','Jobs with your approval','1. Prepare a proposal. 2. Review its exact change. 3. Approve and run. Tasks and records are saved only after approval.'));
    const connectors=panel(content,'cfConnectorsSection','External connections','Review the separate calendar connection panel below for Outlook and Google. No licensed data or equipment connection is implied.');const list=node('dl',undefined,'cf-facts');pair(list,'Live sensor / equipment feeds','Not connected — requires your provider and authorized integration.');pair(list,'Equipment control','Not available — no machinery or irrigation commands are sent.');pair(list,'WSU licensed models','Not connected — a permitted data agreement is required.');pair(list,'Email / buyer systems','Not connected — message drafts stay private until you send them yourself.');pair(list,'Outlook / Google Calendar','Optional secure connection below. Every event requires its own review and approval; no automatic calendar sync.');connectors.append(list);
    const events=panel(content,'cfEventsSection','Activity log','Records of saved changes, proposals and approved operations—not a legal compliance certification.');events.append(Object.assign(node('div'),{id:'cfEventList'}));root.append(content);page.append(root);syncFields();readingMetricHelp();workflowFields();renderLists();
  }
  function render(){
    const expected=owner();if(cacheOwner!==expected){clear();cacheOwner=expected;}mount();window.CalendarConnections?.render();if(!mounted)return;
    get('cfGate').hidden=!!expected;get('cfContent').hidden=!expected;if(!expected){if(typeof membershipAllowsPremium==='function'&&membershipAllowsPremium()){get('cfGate').replaceChildren(node('p','Your private farm connection needs to be refreshed. If a workflow result was uncertain, it may already have saved on the server. Reload before trying an action again.'),button('Reload app to reconnect',()=>location.reload()));}return;}
    const signature=JSON.stringify(fields().map(field=>[field.id,field.name]));if(signature!==fieldSignature){const changed=!!fieldSignature;fieldSignature=signature;syncFields();get('cfFieldIds').replaceChildren(...fields().map(field=>note(`${field.name}: ${field.id}`)));invalidatePreview();if(changed){generation++;controller?.abort();controller=null;busy=false;operations=null;revision=null;renderLists();setStatus('Saved fields changed. Reload private records before continuing.');}}
    updateButtons();
  }
  async function open(){render();syncFields();await Promise.all([owner()&&!operations&&!busy?request():null,window.CalendarConnections?.open()]);}
  function boot(){render();if(active())open();}
  window.ConnectedFarm={boot,render,clear,open,parseCsv};
  window.addEventListener('storage',event=>{if(['farmerDailyCloudOwner','farmerDailyFields'].includes(event.key))render();});
  window.addEventListener('focus',render);
  boot();
})();
