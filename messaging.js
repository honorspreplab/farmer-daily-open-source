'use strict';

// The messaging account lives only on the server. Never persist verification
// commands, verified phone numbers, consent or provider responses in a browser.
(() => {
  const get=id=>document.getElementById(id),names={sms:'SMS text messages',whatsapp:'WhatsApp'};
  const node=(tag,text,className)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(className)item.className=className;return item;};
  const owner=()=>typeof membership!=='undefined'&&membership?.user?.id&&typeof cloudEnabled!=='undefined'&&cloudEnabled&&membership.user.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;
  const note=text=>node('p',text,'messaging-note');
  const checked=id=>!!get(id)?.checked;
  const short=(value,length=400)=>typeof value==='string'?value.slice(0,length):'';
  const channel=id=>data?.channels.find(item=>item.id===id);
  const when=value=>{if(!Number.isFinite(Date.parse(value)))return 'Time not recorded';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:'America/Los_Angeles'}).format(new Date(value))+' Pacific';};
  const uncertainStatuses=new Set(['sending','unknown','uncertain','processing']);
  const deliveryStatuses=new Set(['sending','queued','accepted','sent','delivered','read','failed','undelivered','unknown','uncertain','processing','cancelled','skipped']);
  let cacheOwner=null,data=null,generation=0,controller=null,busy=false,loaded=false,blocked=false;
  const uncertain=new Set();

  function status(text,error=false){const item=get('messagingStatus');if(!item)return;item.textContent=text;item.classList.toggle('messaging-warning',error);}
  function clear(){generation++;controller?.abort();controller=null;cacheOwner=null;data=null;busy=false;loaded=false;blocked=false;uncertain.clear();get('messagingSettings')?.remove();}
  function button(text,action,handler,id,primary=false){const item=node('button',text,primary?'primary':'secondary');item.type='button';item.dataset.messagingAction=action;if(id)item.dataset.channel=id;item.onclick=handler;return item;}
  function checkbox(id,text){const label=node('label',undefined,'messaging-consent'),input=node('input');input.type='checkbox';input.id=id;input.onchange=updateButtons;label.append(input,node('span',text));return label;}
  function labelInput(id,text,type,value=''){const label=node('label',text),input=node('input');input.id=id;input.type=type;input.value=value;label.append(input);return label;}
  function safePhone(value){const digits=String(value||'').trim().replace(/[ ()-]/g,'');if(/^\+[1-9]\d{9,14}$/.test(digits))return digits;if(/^\d{10}$/.test(digits))return '+1'+digits;if(/^1\d{10}$/.test(digits))return '+'+digits;return '';}
  function ownBrief(){return data?.preview&&typeof data.preview.date==='string'&&typeof data.preview.text==='string'&&data.preview.text.length>0?data.preview:null;}
  function unresolved(id){return uncertain.has(id)||(data?.deliveries||[]).some(item=>item.channel===id&&uncertainStatuses.has(item.status));}
  function updateButtons(){
    const signedIn=!!owner()&&owner()===cacheOwner,ready=signedIn&&!!data&&!blocked;
    get('messagingSettings')?.setAttribute('aria-busy',String(busy));
    for(const item of get('messagingSettings')?.querySelectorAll('[data-messaging-action]')||[]){
      const action=item.dataset.messagingAction,id=item.dataset.channel,current=channel(id);
      item.disabled=busy||!signedIn||(action!=='reload'&&action!=='stop'&&!ready);
      if(action==='beginVerification')item.disabled ||= !current?.configured||!checked(`messagingConsent-${id}`)||!safePhone(get(`messagingPhone-${id}`)?.value);
      if(action==='savePreferences')item.disabled ||= !current?.verified||(checked(`messagingDaily-${id}`)&&!checked(`messagingDailyConsent-${id}`));
      if(action==='sendBrief')item.disabled ||= !current?.configured||!current?.verified||typeof current.approvalToken!=='string'||!current.approvalToken||unresolved(id)||!ownBrief()||!checked(`messagingSendConsent-${id}`);
    }
  }
  function assertEnvelope(result){
    if(!result||!Array.isArray(result.channels)||result.channels.length!==2||new Set(result.channels.map(item=>item.id)).size!==2||result.channels.some(item=>!Object.hasOwn(names,item.id)||typeof item.configured!=='boolean'||typeof item.verified!=='boolean'||typeof item.dailyEnabled!=='boolean'||!['production','sandbox','disabled'].includes(item.mode)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.briefTime||''))||!Array.isArray(result.deliveries)||result.deliveries.length>100||result.deliveries.some(item=>!item||typeof item.id!=='string'||!Object.hasOwn(names,item.channel)||!deliveryStatuses.has(item.status))||typeof result.scheduler?.configured!=='boolean')throw new Error('The messaging service returned an unexpected response. Reload messaging status before continuing.');
    return result;
  }
  async function request(action,payload={}){
    const expected=owner();if(!expected||expected!==cacheOwner||busy)return null;
    const ticket=generation,localController=new AbortController();controller=localController;busy=true;updateButtons();let dispatched=false;
    const valid=()=>generation===ticket&&owner()===expected&&cacheOwner===expected;
    const timeout=setTimeout(()=>localController.abort(),25000);
    try{
      dispatched=true;const response=await fetch('/api/messaging',{method:action?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:localController.signal,headers:{Accept:'application/json','X-Farmer-Account-Id':expected,...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify({action,...payload})}:{})});
      if(!valid())return null;
      if(response.type==='opaqueredirect'||response.status===401)throw new Error('Your sign-in expired. Sign in again before changing message delivery.');
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The messaging service is not available yet. Reload messaging status in a moment.');
      const result=await response.json();if(!valid())return null;
      if(!response.ok){const error=new Error(short(result?.error)||`Messaging service unavailable (${response.status}).`);error.status=response.status;throw error;}
      data=assertEnvelope(result);loaded=true;blocked=false;
      for(const id of ['sms','whatsapp'])if(!data.deliveries.some(item=>item.channel===id&&uncertainStatuses.has(item.status)))uncertain.delete(id);
      renderData();
      if(!action)status('Messaging status loaded. Opening this page does not send any messages.');
      else if(action==='beginVerification')status('Verification started. Send the JOIN command from your own phone, then choose “Check verification”. No verification text was sent to you.');
      else if(action==='savePreferences')status(data.scheduler.configured?'Your delivery preferences were saved. Check each channel’s status below; saving is not proof of delivery.':'Preferences saved, but automatic delivery is not configured. No scheduled messages will be sent until server setup is complete.');
      else if(action==='stop')status(`${names[payload.channel]} stopped. Already submitted messages cannot be recalled. Other channels keep their own settings.`);
      else if(action==='sendBrief')status('The recorded delivery result is shown below. Accepted or sent does not mean delivered. Do not send another copy while a result is unconfirmed.');
      return result;
    }catch(error){
      if(!valid())return null;
      if(action==='sendBrief'&&dispatched){uncertain.add(payload.channel);status('The send result could not be confirmed. A message may already have been sent. Reload status and check your phone; do not submit another copy. The app will not automatically retry this request.',true);renderHistory();}
      else{blocked=true;status(error.name==='AbortError'?'The messaging request timed out. Reload status to check what was saved before trying again.':error.message,true);}
      return null;
    }finally{clearTimeout(timeout);if(controller===localController){controller=null;busy=false;updateButtons();}}
  }
  const reload=()=>request();
  function renderChannel(id){
    const current=channel(id),card=node('article',undefined,'messaging-card');card.id=`messagingCard-${id}`;card.append(node('h3',names[id]));
    if(!current){card.append(note('Reload messaging status to check this channel.'));return card;}
    const mode=current.mode==='sandbox'?'Sandbox / testing only':current.mode==='production'?'Production provider':'Not configured';
    card.append(node('p',`${mode} · ${current.verified?'Number verified':'Number not verified'}`,'messaging-badge'));
    if(!current.configured)card.append(note('Administrator setup is required. No messages can be sent on this channel yet. You never need to enter a provider password or secret here.'));
    if(current.mode==='sandbox')card.append(node('p','WhatsApp sandbox is testing only. First join the provider sandbox separately, then send the app’s JOIN command below. Manual messages are possible only in the provider’s recent-message window; scheduled daily delivery is not enabled in sandbox.','messaging-warning'));
    if(current.sender)card.append(note(`Business sender: ${short(current.sender,50)}`));
    if(current.maskedPhone)card.append(note(`Your number: ${short(current.maskedPhone,40)}`));
    if(current.status)card.append(note(`Channel status: ${short(current.status,100)}`));
    if(current.status==='stopped'||current.verification)card.append(note('If you previously sent STOP, first send START (or UNSTOP) from your phone to this same business sender to clear the provider’s block. Then send a fresh Farmer Daily JOIN command. START alone never re-enables daily delivery in this app; verify again and separately approve your daily schedule.'));
    if(current.dailyEnabled)card.append(note(`Daily preference: ${current.briefTime} Pacific. ${!data.scheduler.configured?'Automatic sending is not configured.':!current.configured||!current.verified?'Waiting for channel setup and number verification.':current.mode==='sandbox'?'Sandbox cannot send scheduled briefs.':'Enabled; delivery still depends on provider availability and delivery rules.'}`));
    else card.append(note('Automatic daily briefs: off.'));
    if(!current.verified){
      const form=node('form');form.id=`messagingVerifyForm-${id}`;
      const phone=labelInput(`messagingPhone-${id}`,'Your own mobile number','tel');phone.querySelector('input').autocomplete='tel';phone.querySelector('input').placeholder='+1 425 555 0123';phone.querySelector('input').maxLength=24;phone.querySelector('input').oninput=updateButtons;
      form.append(phone,note('Enter + and country code, or a 10-digit US number. Do not register someone else’s number. This value is never saved in this browser.'),checkbox(`messagingConsent-${id}`,`I own this number and agree to receive Farmer Daily briefs on ${names[id]}. My number and brief excerpt are shared with Twilio${id==='whatsapp'?' and WhatsApp (Meta)':''} for delivery. Messages may be visible on my lock screen. Message/data rates may apply. This is separate from any old profile preference.`));
      const begin=button('Get my verification instructions','beginVerification',null,id,true);begin.id=`messagingVerify-${id}`;begin.type='submit';form.append(begin);form.onsubmit=event=>{event.preventDefault();const phoneValue=safePhone(get(`messagingPhone-${id}`).value);if(!phoneValue||!checked(`messagingConsent-${id}`))return;request('beginVerification',{channel:id,phone:phoneValue,consent:true});};card.append(form);
      const verification=current.verification;
      if(verification&&typeof verification.command==='string'&&typeof verification.sender==='string'){
        const instructions=node('section');instructions.append(node('h4','Verify from your phone'),note(`From the number you entered, send this exact command in ${names[id]} to ${short(verification.sender,50)}:`),node('p',short(verification.command,100),'messaging-command'),note(`Expires: ${when(verification.expiresAt)}. Keep this command private. Then return here and check verification.`));const check=button('Check verification','reload',reload,id);check.id=`messagingCheck-${id}`;instructions.append(check);card.append(instructions);
      }
    }else{
      const preferences=node('form');preferences.id=`messagingPreferences-${id}`;
      const daily=checkbox(`messagingDaily-${id}`,'Send my daily brief automatically');daily.querySelector('input').checked=current.dailyEnabled;
      preferences.append(daily,labelInput(`messagingTime-${id}`,'Daily delivery time · Pacific','time',current.briefTime),checkbox(`messagingDailyConsent-${id}`,`I approve recurring daily brief excerpts to this verified number on ${names[id]}. This can send while the app is closed after the administrator configures scheduling. I can stop anytime.`));
      const save=button('Save daily delivery preference','savePreferences',null,id,true);save.id=`messagingSave-${id}`;save.type='submit';preferences.append(save);preferences.onsubmit=event=>{event.preventDefault();const dailyEnabled=checked(`messagingDaily-${id}`);if(dailyEnabled&&!checked(`messagingDailyConsent-${id}`))return;request('savePreferences',{channel:id,dailyEnabled,briefTime:get(`messagingTime-${id}`).value,consent:dailyEnabled&&checked(`messagingDailyConsent-${id}`)});};card.append(preferences);
      card.append(checkbox(`messagingSendConsent-${id}`,`Send my current saved brief excerpt once to this verified ${names[id]} number. This is a real message and cannot be recalled; it uses today’s one-message allowance for this channel.`));
      const send=button('Send my current brief once','sendBrief',()=>{if(checked(`messagingSendConsent-${id}`)&&typeof current.approvalToken==='string'&&current.approvalToken)request('sendBrief',{channel:id,approved:true,approvalToken:current.approvalToken});},id,true);send.id=`messagingSend-${id}`;card.append(send);
      if(!ownBrief())card.append(note('Open Today and prepare your daily brief first. Then return here and reload messaging status before sending.'));
      else if(!current.approvalToken)card.append(note('A current send approval could not be prepared. Reload messaging status, review the refreshed excerpt, and approve again. Approvals expire after 15 minutes and cannot be reused after the brief or delivery settings change.'));
    }
    card.append(note('To unsubscribe, send STOP to this business sender on this channel, or use the stop button below. Stopping SMS does not stop WhatsApp, or vice versa. This service is not emergency monitoring.'));
    const actions=node('div',undefined,'messaging-actions'),stop=button(`Stop ${names[id]}`,'stop',()=>request('stop',{channel:id}),id);stop.id=`messagingStop-${id}`;actions.append(stop);card.append(actions);return card;
  }
  function renderHistory(){
    const target=get('messagingHistory');if(!target)return;target.replaceChildren(node('h3','Recent delivery attempts'));
    target.append(note('Accepted / queued = the provider accepted the request, not proof the phone received it. Sent = passed onward. Delivered / read = provider receipt, not a guarantee the farmer reviewed it. Unknown = do not resend; check the phone and reload.'));
    for(const id of uncertain)target.append(node('p',`${names[id]}: the last send result is unknown. Check your phone before any further action.`,'messaging-warning'));
    if(!data?.deliveries.length){target.append(note('No recorded delivery attempts.'));return;}
    const list=node('ol',undefined,'messaging-delivery-list');for(const item of data.deliveries){const row=node('li');row.append(node('b',`${names[item.channel]} · ${item.status}`),node('div',when(item.createdAt)));if(item.message)row.append(note(short(item.message)));list.append(row);}target.append(list);
  }
  function renderData(){
    const grid=get('messagingChannels');if(!grid)return;grid.replaceChildren(renderChannel('sms'),renderChannel('whatsapp'));
    get('messagingScheduleStatus').textContent=data?(data.scheduler.configured?'Server scheduling is configured. Individual channels still require verification, explicit daily consent, and production provider approval.':'Automatic delivery is not configured. The app cannot send scheduled briefs while closed until an administrator connects the server scheduler.'):'Reload status to check automatic delivery.';
    const preview=get('messagingBriefPreview');preview.replaceChildren();const brief=ownBrief();if(brief){preview.append(node('summary',`Review your saved brief excerpt · ${short(brief.date,20)}`),note('This server-generated excerpt is sent with a link back to the app. A production WhatsApp message also uses its approved template wording. Check the date and source details in Today before acting.'),node('p',short(brief.text,1200)));}else preview.append(node('summary','No current saved brief available to send'),note('Open Today to prepare your daily brief, then reload messaging status.'));
    renderHistory();updateButtons();
  }
  function mount(){
    const settings=get('settingsPage');if(!settings||get('messagingSettings'))return;
    const root=node('section',undefined,'messaging-settings');root.id='messagingSettings';root.setAttribute('aria-labelledby','messagingHeading');const heading=node('h2','Messages & WhatsApp');heading.id='messagingHeading';
    root.append(heading,note('Real delivery to your own verified number, available on the Free plan. Each channel has its own consent and stop control. Daily briefs are supported; crew broadcasts and urgent safety-alert delivery are not.'),note('Your number is stored encrypted on the server and shown masked here. Twilio (and Meta for WhatsApp) receives the recipient number and message excerpt. Do not put sensitive personal details into your farm brief.'));
    const message=node('p','','messaging-status');message.id='messagingStatus';message.setAttribute('role','status');message.setAttribute('aria-live','polite');const reloadButton=button('Reload messaging status','reload',reload);reloadButton.id='messagingReload';root.append(message,reloadButton);
    const schedule=note('');schedule.id='messagingScheduleStatus';root.append(schedule);
    const instructions=node('details');instructions.append(node('summary','How to start receiving briefs'));const steps=node('ol');for(const text of ['Wait for administrator provider setup to show ready. You never enter an app secret here.','Enter your own number and agree separately for SMS or WhatsApp.','Send the private JOIN command from that number to the shown business sender, then check verification. WhatsApp sandbox also needs the provider’s sandbox join step.','Review your saved brief and explicitly send it once, or approve daily delivery and save a Pacific-time schedule.','Check the recorded delivery result and your phone. A provider acceptance is not a delivery receipt.'])steps.append(node('li',text));instructions.append(steps,note('SMS/WhatsApp providers can charge the app owner. Existing profile checkboxes never activate verified consent or delivery. No automatic messages are enabled for an existing user.'));root.append(instructions);
    const preview=node('details');preview.id='messagingBriefPreview';root.append(preview,Object.assign(node('div',undefined,'messaging-grid'),{id:'messagingChannels'}),Object.assign(node('section',undefined,'messaging-history'),{id:'messagingHistory'}));settings.append(root);renderData();
  }
  function render(){const expected=owner();if(expected!==cacheOwner){clear();cacheOwner=expected;}mount();if(!expected)status('Sign in and reconnect your private farm before managing message delivery.');updateButtons();}
  async function open(){render();if(owner()&&!loaded&&!busy)await reload();}
  window.FarmerMessaging={render,open,clear};
  window.addEventListener('storage',event=>{if(event.key==='farmerDailyCloudOwner')render();});
  window.addEventListener('focus',()=>{if(get('messagingSettings'))render();});
})();
