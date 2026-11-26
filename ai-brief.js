'use strict';
// Optional external AI only after a fresh evidence/tool preview and approval.
// Never persist evidence, results, consent or preview tokens in browser storage.
(() => {
  const get=id=>document.getElementById(id);
  const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(className)n.className=className;return n;};
  const short=(value,max=1000)=>typeof value==='string'?value.slice(0,max):'';
  const owner=()=>typeof membership!=='undefined'&&membership?.user?.id&&typeof cloudEnabled!=='undefined'&&cloudEnabled&&get('accountGate')?.hidden&&membership.user.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;
  const briefKey=()=>{try{return typeof savedDailyBrief!=='undefined'&&typeof savedDailyBriefOwner!=='undefined'&&savedDailyBriefOwner===owner()?JSON.stringify(savedDailyBrief):'';}catch{return '';}};
  const identity=()=>JSON.stringify([owner(),briefKey()]);
  const firstName=()=>owner()&&typeof savedDailyBriefOwner!=='undefined'&&savedDailyBriefOwner===owner()&&typeof profile!=='undefined'?short(profile?.firstName,80).trim():'';
  const money=value=>Number.isFinite(value)&&value>=0?`$${value.toFixed(value<0.01?6:4)}`:'not reported';
  let currentIdentity='',preview=null,controller=null,generation=0,busy=false;
  const panel=get('aiBriefPanel');if(!panel)return;
  function status(text,error=false){get('aiBriefStatus').textContent=text;get('aiBriefStatus').classList.toggle('ai-brief-warning',error);}
  function buttons(){
    panel.setAttribute('aria-busy',String(busy));
    get('aiBriefReload').disabled=busy||!owner();
    get('aiBriefMode').disabled=busy;get('aiBriefTask').disabled=busy;
    get('aiBriefConsent').disabled=busy||!owner()||!preview?.enabled||!preview?.available||!preview?.previewToken;
    get('aiBriefSend').disabled=busy||get('aiBriefConsent').disabled||!get('aiBriefConsent').checked;
  }
  function clear(message='Account or saved brief changed. Load a new evidence preview before using AI.'){
    generation++;controller?.abort();controller=null;busy=false;preview=null;currentIdentity=identity();
    get('aiBriefConsent').checked=false;get('aiBriefEvidence').textContent='No evidence loaded.';get('aiBriefTools').replaceChildren();get('aiBriefEvidenceDetails').open=false;
    get('aiBriefResult').replaceChildren();get('aiBriefFieldLabels').replaceChildren();get('aiBriefGreeting').textContent='Your optional AI daily-message draft';get('aiBriefModels').textContent='Model options and budget are checked only when you load this panel.';
    status(message);buttons();
  }
  function sync(){if(identity()!==currentIdentity)clear();else buttons();}
  function validPreview(data){
    if(!data||typeof data.enabled!=='boolean'||typeof data.available!=='boolean'||typeof data.consentVersion!=='string'||data.consentVersion!=='ai-evidence-v1'||!data.models||typeof data.models.economy!=='string'||typeof data.models.analysis!=='string'||!Number.isFinite(data.dailyLimitUsd)||data.dailyLimitUsd<0)throw new Error('AI setup returned an unexpected response. Your source-based brief is unchanged.');
    if(data.enabled&&data.available&&(typeof data.previewToken!=='string'||!data.previewToken||data.evidence==null))throw new Error('A complete evidence preview is required before AI can run.');
    if(!data.toolPreview||!Array.isArray(data.toolPreview.tools)||!Array.isArray(data.toolPreview.dataCategories)||typeof data.toolPreview.mayRefreshWeather!=='boolean'||data.toolPreview.tools.some(tool=>typeof tool?.name!=='string'||!Array.isArray(tool.fields)||tool.fields.some(field=>typeof field!=='string'))||data.toolPreview.dataCategories.some(value=>typeof value!=='string'))throw new Error('A complete read-only tool permission preview is required before AI can run.');
    if(data.fieldLabels!==undefined&&(!Array.isArray(data.fieldLabels)||data.fieldLabels.length>50||data.fieldLabels.some(field=>!/^Field [1-9][0-9]*$/.test(field?.alias)||typeof field.name!=='string')||new Set(data.fieldLabels.map(field=>field.alias)).size!==data.fieldLabels.length))throw new Error('The private field-name legend could not be verified. Reload the preview.');
    return data;
  }
  function fieldLegend(labels){
    const legend=node('div',undefined,'ai-brief-field-labels');if(!Array.isArray(labels)||!labels.length)return legend;
    legend.append(node('p','Your field names — shown only in this app, not sent to OpenAI.','ai-brief-note'));
    const list=node('ul');for(const field of labels)list.append(node('li',`${short(field.alias,40)}: ${short(field.name,200)}`));legend.append(list);return legend;
  }
  function renderPreview(data){
    preview=validPreview(data);get('aiBriefConsent').checked=false;get('aiBriefResult').replaceChildren();
    get('aiBriefGreeting').textContent=firstName()?`${firstName()}, your optional AI daily-message draft`:'Your optional AI daily-message draft';
    get('aiBriefFieldLabels').replaceChildren(fieldLegend(data.fieldLabels));
    get('aiBriefEvidence').textContent=data.evidence==null?'No current saved-brief evidence is available.':JSON.stringify(data.evidence,null,2);
    const tools=get('aiBriefTools');tools.replaceChildren(node('h3','Read-only tools this request may use'));
    const list=node('ul');for(const tool of data.toolPreview.tools)list.append(node('li',`${short(tool.name,160)}${tool.fields.length?` — ${tool.fields.map(field=>short(field,100)).join(', ')}`:''}`));tools.append(list);
    tools.append(node('p',`Permitted information: ${data.toolPreview.dataCategories.map(value=>short(value,160)).join('; ')||'No additional categories'}.`),node('p',data.toolPreview.mayRefreshWeather?'The model may request fresh weather for permitted fields. New source results can be added after this preview.':'Fresh weather retrieval is not permitted in this preview.'));
    tools.append(node('p','NASA/USGS satellite tools read previously derived, dated history; they do not request new imagery or show a live image. Field source permissions still apply. No messages, purchases, equipment commands or task changes are permitted.','ai-brief-note'));
    get('aiBriefModels').textContent=`Economy: ${short(data.models.economy,120)}. Deeper analysis: ${short(data.models.analysis,120)}. Configured daily AI budget: ${money(data.dailyLimitUsd)}. This is a model-cost estimate limit, not a provider bill or a promise of savings.`;
    get('aiBriefEvidenceDetails').open=!!data.enabled&&!!data.available;
    if(!data.enabled)status(short(data.reason)||'Optional AI needs administrator setup. Your source-based daily brief still works.');
    else if(!data.available)status(short(data.reason)||'Prepare a current daily brief on Today, then reload this evidence preview.');
    else status('Initial evidence and tool permissions loaded. Review both and explicitly approve one request. Loading this preview has not called an AI model.');
    buttons();
  }
  function renderAnswer(data){
    if(!data||typeof data.answer?.summary!=='string'||!Array.isArray(data.answer.points)||data.answer.points.length>20||data.answer.points.some(point=>typeof point?.text!=='string'||!Array.isArray(point.evidenceIds)||point.evidenceIds.some(id=>typeof id!=='string'))||typeof data.model!=='string'||typeof data.routeReason!=='string')throw new Error('AI returned an unexpected explanation. Use your unchanged source-based brief.');
    const target=get('aiBriefResult');target.replaceChildren(node('h3',firstName()?`${firstName()}, here is your AI draft`:'Your optional AI draft'));
    target.append(fieldLegend(preview?.fieldLabels));
    target.append(node('p',short(data.answer.summary,5000)));
    const list=node('ul');for(const point of data.answer.points){const item=node('li',short(point.text,3000));item.append(node('p',point.evidenceIds.length?`Evidence references: ${point.evidenceIds.map(id=>short(id,100)).join(', ')}`:'No evidence reference returned. Verify this point before acting.','ai-brief-note'));list.append(item);}target.append(list);
    target.append(node('p',`Model actually used: ${short(data.model,160)}`,'ai-brief-model'),node('p',`Why this route: ${short(data.routeReason,1000)}`));
    if(Array.isArray(data.modelSteps)){const steps=node('ul');for(const step of data.modelSteps.slice(0,8)){if(typeof step?.model==='string')steps.append(node('li',`${short(step.purpose,40)||'Model step'}: ${short(step.model,160)} — ${short(step.routeReason,600)}`));}target.append(node('h3','Model steps'),steps);}
    if(Array.isArray(data.toolsUsed)){const tools=node('ul');for(const tool of data.toolsUsed.slice(0,20)){if(typeof tool?.tool==='string')tools.append(node('li',`${short(tool.tool,160)}${typeof tool.field==='string'?` · ${short(tool.field,100)}`:''} · ${short(tool.status,60)||'Status not reported'}${Array.isArray(tool.evidenceIds)&&tool.evidenceIds.length?` · Evidence: ${tool.evidenceIds.filter(id=>typeof id==='string').map(id=>short(id,100)).join(', ')}`:''}`));}target.append(node('h3','Read-only tools actually used'),tools);}
    const input=Number.isSafeInteger(data.usage?.inputTokens)?data.usage.inputTokens:'not reported',output=Number.isSafeInteger(data.usage?.outputTokens)?data.usage.outputTokens:'not reported';
    target.append(node('p',`Reported tokens: ${input} input / ${output} output. Estimated model cost: ${money(data.usage?.estimatedUsd)}. This is not an invoice or proven cost saving.`,'ai-brief-note'));
    if(data.budget)target.append(node('p',`Daily budget: ${money(data.budget.dailyLimitUsd)}. Reserved amount: ${money(data.budget.reservedUsd)}; reservations are not a settled bill.`,'ai-brief-note'));
    const evidence=node('details');evidence.append(node('summary','Final evidence, including any permitted tool results'),node('pre',JSON.stringify(data.evidence??preview?.evidence??null,null,2),'ai-brief-evidence'));target.append(evidence,node('p','This is a reviewable draft, not an automatically sent daily message. AI can make mistakes. Check the original brief, source dates and conditions before making farm decisions. No task was changed and no message was sent.','ai-brief-note'));
  }
  async function request(send=false){
    sync();const expected=owner();if(!expected||busy)return;
    if(send&&(!preview?.enabled||!preview?.available||!preview.previewToken||!get('aiBriefConsent').checked))return;
    const ticket=generation,key=identity(),localController=new AbortController();controller=localController;busy=true;
    const payload=send?{task:get('aiBriefTask').value,mode:get('aiBriefMode').value,consent:true,consentVersion:preview.consentVersion,previewToken:preview.previewToken}:null;
    get('aiBriefConsent').checked=false;buttons();status(send?'Preparing your optional AI draft with permitted read-only tools. Your source-based brief remains available above.':'Loading the initial minimized evidence and read-only tool permissions. This does not call an AI model.');
    const valid=()=>ticket===generation&&owner()===expected&&identity()===key;
    const timer=setTimeout(()=>localController.abort(),70000);
    try{
      const response=await fetch('/api/ai-brief',{method:send?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:localController.signal,headers:{Accept:'application/json','X-Farmer-Account-Id':expected,...(send?{'Content-Type':'application/json'}:{})},...(send?{body:JSON.stringify(payload)}:{})});
      if(!valid())return;
      if(response.type==='opaqueredirect'||response.status===401)throw new Error('Sign in again before requesting optional AI.');
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The optional AI endpoint is unavailable. Your source-based brief is unchanged.');
      const result=await response.json();if(!valid())return;
      if(!response.ok)throw new Error(short(result?.error)||`Optional AI unavailable (HTTP ${response.status}).`);
      if(send){renderAnswer(result);preview=null;status('Optional explanation ready. To request another, reload the evidence and approve again. Your original brief has not been replaced.');}
      else renderPreview(result);
    }catch(error){if(valid()){preview=null;get('aiBriefConsent').checked=false;status(`${error.name==='AbortError'?'Optional AI timed out.':short(error.message)||'Optional AI failed.'} Your source-based brief remains available. ${send?'This request may have reached the provider; there is no automatic retry. ':''}Reload the evidence before another request.`,true);}}
    finally{clearTimeout(timer);if(controller===localController){controller=null;busy=false;buttons();}}
  }
  const content=get('aiBriefContent'),greeting=node('h3','Your optional AI daily-message draft');greeting.id='aiBriefGreeting';content.append(greeting,node('p','Your source-based daily brief and existing chat use recorded data and explainable rules. Optional AI can write a personalized daily-message draft, select permitted read-only data tools, or explain the evidence. It does not replace source checks or send messages.','ai-brief-note'));
  const choices=node('div',undefined,'ai-brief-choices');
  for(const [id,title,options]of [['aiBriefMode','Model route',[['auto','Auto'],['economy','Economy'],['analysis','Deeper analysis']]],['aiBriefTask','What should AI do?',[['daily','Write my daily message'],['summary','Summary'],['explain','Explain priorities'],['compare','Compare fields']]]]){
    const label=node('label',title),select=node('select');select.id=id;for(const [value,title]of options){const option=node('option',title);option.value=value;select.append(option);}select.onchange=()=>{sync();get('aiBriefConsent').checked=false;get('aiBriefResult').replaceChildren();buttons();};label.append(select);choices.append(label);
  }content.append(choices);
  const models=node('p','Model options and budget are checked only when you load this panel.','ai-brief-note');models.id='aiBriefModels';content.append(models);
  const reload=node('button','Load / reload evidence preview','secondary');reload.type='button';reload.id='aiBriefReload';reload.onclick=()=>request();content.append(reload);
  const info=node('p','Nothing is sent to OpenAI until you approve and choose Run AI once.','ai-brief-status');info.id='aiBriefStatus';info.setAttribute('role','status');info.setAttribute('aria-live','polite');content.append(info);
  const labels=node('div');labels.id='aiBriefFieldLabels';content.append(labels);
  const evidence=node('details');evidence.id='aiBriefEvidenceDetails';evidence.append(node('summary','Review initial evidence and permitted read-only tools'));const pre=node('pre','No evidence loaded.','ai-brief-evidence');pre.id='aiBriefEvidence';evidence.append(pre);const tools=node('div');tools.id='aiBriefTools';evidence.append(tools);content.append(evidence);
  content.append(node('p','You approve the initial minimized evidence above and new results from the listed read-only tools. Fields use aliases rather than identifying names. OpenAI processes that evidence using store:false; this does not mean zero retention. Provider processing rules still apply. No automatic AI calls, delivery or scheduling are enabled.','ai-brief-note'));
  const consentLabel=node('label',undefined,'ai-brief-consent'),consent=node('input');consent.id='aiBriefConsent';consent.type='checkbox';consent.onchange=()=>{sync();buttons();};consentLabel.append(consent,node('span','I reviewed the initial evidence and listed read-only tool permissions. I approve one OpenAI run, including any permitted tool results and model steps. It may use the app owner’s paid AI allowance.'));content.append(consentLabel);
  const send=node('button','Run AI once','primary');send.type='button';send.id='aiBriefSend';send.onclick=()=>request(true);content.append(send);const result=node('section');result.id='aiBriefResult';result.setAttribute('aria-live','polite');content.append(result);
  panel.addEventListener('toggle',()=>{sync();if(panel.open&&owner()&&!preview&&!busy)request();});
  new MutationObserver(sync).observe(get('dailyBriefPanel'),{childList:true,subtree:true});
  new MutationObserver(sync).observe(get('accountGate'),{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('storage',event=>{if(event.key==='farmerDailyCloudOwner')sync();});window.addEventListener('focus',sync);window.addEventListener('pagehide',()=>clear());
  window.FarmerAiBrief={clear,sync};currentIdentity=identity();buttons();
})();
