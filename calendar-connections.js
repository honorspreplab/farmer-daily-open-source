'use strict';

// Calendar credentials and authorization codes never enter this module. The
// server holds tokens; this panel keeps only owner-scoped display data in memory.
(() => {
  const get=id=>document.getElementById(id);
  const node=(tag,text,className)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(className)item.className=className;return item;};
  const providers={outlook:{name:'Outlook',host:'login.microsoftonline.com',permissions:'https://learn.microsoft.com/en-us/graph/permissions-reference#calendarsreadwrite'},google:{name:'Google',host:'accounts.google.com',permissions:'https://developers.google.com/workspace/calendar/api/auth'}};
  const owner=()=>typeof membership!=='undefined'&&membership?.user?.id&&membership.user.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;
  const taskList=()=>typeof tasks!=='undefined'&&Array.isArray(tasks)?tasks:[];
  const short=value=>typeof value==='string'?value.slice(0,300):'';
  const note=text=>node('p',text,'calendar-note');
  const button=(text,handler,primary=false)=>{const item=node('button',text,primary?'primary':'secondary');item.type='button';item.onclick=handler;return item;};
  const pendingStatuses=new Set(['pending','proposed']);
  const uncertainStatuses=new Set(['sending','executing','processing','unknown','uncertain']);
  const terminalStatuses=new Set(['executed','completed','cancelled','failed','expired']);
  let cacheOwner=null,data=null,generation=0,controller=null,busy=false,loaded=false,blocked=false;
  const uncertain=new Set();

  function status(text,error=false){const item=get('calendarStatus');if(!item)return;item.textContent=text;item.classList.toggle('calendar-warning',error);}
  function checked(id){return !!get(id)?.checked;}
  function link(text,url){const item=node('a',text);item.href=url;item.target='_blank';item.rel='noopener noreferrer';return item;}
  function clear(){generation++;controller?.abort();controller=null;cacheOwner=null;data=null;busy=false;loaded=false;blocked=false;uncertain.clear();get('calendarConnections')?.remove();}
  function confirmUnknown(){return uncertain.size>0||(data?.proposals||[]).some(item=>uncertainStatuses.has(item.status));}
  function updateButtons(){
    const signedIn=!!owner()&&owner()===cacheOwner,ready=signedIn&&!!data&&!blocked;
    get('calendarConnections')?.setAttribute('aria-busy',String(busy));
    for(const item of get('calendarConnections')?.querySelectorAll('[data-calendar-action]')||[]){
      const action=item.dataset.calendarAction;
      item.disabled=busy||!signedIn||(action!=='reload'&&!ready);
      if(action==='connect'){const provider=data?.providers.find(provider=>provider.id===item.dataset.provider);item.disabled ||= !data?.canConnect||!provider?.configured||['connecting','uncertain'].includes(provider.connectionStatus)||!checked(`calendarConsent-${item.dataset.provider}`);}
      if(action==='prepare')item.disabled ||= !data?.canConnect||confirmUnknown()||!get('calendarTask')?.value||!data.providers.find(provider=>provider.id===get('calendarProvider')?.value)?.connected;
      if(action==='execute')item.disabled ||= !data?.canConnect||confirmUnknown()||!checked(`calendarApprove-${item.dataset.proposal}`)||!data.proposals.some(proposal=>proposal.id===item.dataset.proposal&&pendingStatuses.has(proposal.status)&&Date.parse(proposal.expiresAt)>Date.now());
      if(action==='cancel')item.disabled ||= uncertain.has(item.dataset.proposal);
    }
  }
  function actionButton(text,action,handler,options={}){const item=button(text,handler,options.primary);item.dataset.calendarAction=action;if(options.id)item.id=options.id;if(options.provider)item.dataset.provider=options.provider;if(options.proposal)item.dataset.proposal=options.proposal;return item;}
  function assertEnvelope(result){
    if(!result||!Array.isArray(result.providers)||!Array.isArray(result.proposals)||typeof result.canConnect!=='boolean')throw new Error('The calendar service returned an unexpected response. Reload connections before continuing.');
    if(result.providers.length!==2||new Set(result.providers.map(item=>item.id)).size!==2||result.providers.some(item=>!Object.hasOwn(providers,item.id)||typeof item.connected!=='boolean'||typeof item.configured!=='boolean'))throw new Error('The calendar service returned invalid provider details. Reload connections before continuing.');
    if(result.proposals.length>100||result.proposals.some(proposal=>!validProposal(proposal)))throw new Error('The saved calendar proposals could not be verified. Reload connections before continuing.');
    return result;
  }
  function validProposal(item){const preview=item?.preview;return !!item&&typeof item.id==='string'&&Object.hasOwn(providers,item.provider)&&[...pendingStatuses,...uncertainStatuses,...terminalStatuses].includes(item.status)&&!!preview&&typeof preview.title==='string'&&preview.title.length>0&&typeof preview.allDay==='boolean'&&preview.timeZone==='America/Los_Angeles'&&(preview.allDay?/^\d{4}-\d{2}-\d{2}$/.test(preview.date||'')&&/^\d{4}-\d{2}-\d{2}$/.test(preview.endDate||''):Number.isFinite(Date.parse(preview.startUtc))&&Number.isFinite(Date.parse(preview.endUtc)));}
  async function request(action,payload={}){
    const expected=owner();if(!expected||expected!==cacheOwner||busy)return null;
    const ticket=generation,localController=new AbortController();let dispatched=false;controller=localController;busy=true;updateButtons();
    const valid=()=>ticket===generation&&owner()===expected&&cacheOwner===expected;
    const timer=setTimeout(()=>localController.abort(),25000);
    try{
      if(action==='prepare'||action==='execute'){
        if(typeof saveCloudState!=='function'||!await saveCloudState())throw new Error('Your farm tasks could not sync. Reconnect your farm before preparing a calendar event. Nothing was sent to a calendar.');
        if(!valid())return null;
      }
      dispatched=true;const response=await fetch('/api/calendar-connections',{method:action?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'manual',signal:localController.signal,headers:{Accept:'application/json','X-Farmer-Account-Id':expected,...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify({action,...payload})}:{})});
      if(!valid())return null;
      if(response.type==='opaqueredirect'||response.status===401)throw new Error('Your sign-in expired. Sign in again before managing calendar connections.');
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The calendar service is not available yet. Reload connections in a moment.');
      const result=await response.json();if(!valid())return null;
      if(!response.ok){const error=new Error(typeof result.error==='string'?result.error.slice(0,400):`Calendar service unavailable (${response.status}).`);error.status=response.status;throw error;}
      if(action&&((['prepare','execute','cancel'].includes(action)&&!validProposal(result.proposal))||(action==='begin'&&typeof result.authorizationUrl!=='string')||(action==='disconnect'&&result.disconnected!==true)||(action==='deleteProposal'&&result.removed!==true)))throw new Error('The calendar result could not be verified. Reload connections before continuing.');
      if(!action){data=assertEnvelope(result);loaded=true;blocked=false;for(const proposal of data.proposals)if(terminalStatuses.has(proposal.status))uncertain.delete(proposal.id);renderData();status(confirmUnknown()?'A calendar event has an unconfirmed result. Check the provider calendar; do not create it again. No automatic retry will occur.':'Calendar connection status loaded. No event has been sent by opening this page.',confirmUnknown());}
      else if(action!=='begin'){
        if(result.providers&&result.proposals)data=assertEnvelope(result);
        else if(result.proposal&&data){const index=data.proposals.findIndex(item=>item.id===result.proposal.id);if(index<0)data.proposals.unshift(result.proposal);else data.proposals[index]=result.proposal;}
        if(result.proposal&&terminalStatuses.has(result.proposal.status))uncertain.delete(result.proposal.id);
        renderData();
      }
      return result;
    }catch(error){
      if(!valid())return null;
      if(action==='execute'&&dispatched){uncertain.add(payload.proposalId);status('The event result could not be confirmed. It may already be in your calendar. Check your Farmer Daily calendar, then reload connections. Do not create or approve another copy. No automatic retry will occur.',true);renderProposals();}
      else {blocked=true;status(error.name==='AbortError'?'The calendar request timed out. Reload connections to check the result before trying again.':error.message,true);}
      return null;
    }finally{clearTimeout(timer);if(controller===localController){controller=null;busy=false;updateButtons();}}
  }
  async function reload(){return request();}
  async function connect(provider){
    if(!Object.hasOwn(providers,provider)||!checked(`calendarConsent-${provider}`))return;
    status('Preparing the provider sign-in page. You will review its permissions there.');
    const result=await request('begin',{provider,allowCalendarCreation:true});if(!result)return;
    try{const url=new URL(result.authorizationUrl);if(url.protocol!=='https:'||url.hostname!==providers[provider].host||url.port||url.username||url.password)throw new Error();location.assign(url.href);}
    catch{blocked=true;status('The provider sign-in address could not be verified. Nothing was connected. Reload connections before trying again.',true);updateButtons();}
  }
  async function disconnect(provider){
    if(!confirm(`Disconnect ${providers[provider].name} from Farmer Daily? This removes the app's stored connection. Your provider calendar and existing events are kept. You can also remove app permissions in your provider account.`))return;
    const result=await request('disconnect',{provider});if(!result)return;
    if(!result.providers){data=null;await reload();}
    status(`${providers[provider].name} disconnected from Farmer Daily. Existing calendars and events were kept. To remove provider permissions, use the provider's account settings.`);
  }
  function checkbox(id,text){const label=node('label',undefined,'calendar-consent'),control=node('input');control.type='checkbox';control.id=id;control.onchange=updateButtons;label.append(control,node('span',text));return label;}
  function renderProviders(){
    const target=get('calendarProviders');if(!target)return;target.replaceChildren();
    for(const id of ['outlook','google']){
      const provider=data?.providers.find(item=>item.id===id),card=node('article',undefined,'calendar-card');card.id=`calendarCard-${id}`;card.append(node('h4',`${providers[id].name} Calendar`));
      const unresolved=['connecting','uncertain'].includes(provider?.connectionStatus);
      const state=!provider?'Status not loaded':unresolved?'Connection result unconfirmed':provider.needsReconnect?'Reconnect required':provider.connected?'Connected':provider.configured?'Ready to connect':'Administrator setup required';card.append(node('p',state,'calendar-badge'));
      if(unresolved)card.append(node('p','A connection attempt may still be completing. Reload connections and check your provider before trying again. A calendar may already have been created.','calendar-warning'));
      if(provider?.connected||provider?.needsReconnect||unresolved){
        if(provider.accountLabel)card.append(note(`Account: ${short(provider.accountLabel)}`));
        if(provider.calendarName)card.append(note(`Calendar: ${short(provider.calendarName)}`));
        if(provider.connectedAt&&Number.isFinite(Date.parse(provider.connectedAt)))card.append(note(`Connected: ${new Date(provider.connectedAt).toLocaleDateString()}`));
        card.append(actionButton(`Disconnect ${providers[id].name}`,'disconnect',()=>disconnect(id),{id:`calendarDisconnect-${id}`,provider:id}));
        card.append(link(`Open ${providers[id].name} Calendar`,id==='google'?'https://calendar.google.com/':'https://outlook.live.com/calendar/'));
        card.append(link('Manage provider permissions',id==='google'?'https://myaccount.google.com/connections':'https://account.live.com/consent/Manage'));
      }
      if(!provider?.configured){
        card.append(note(provider?'The app owner must finish secure provider setup before this button can work. No sensor or CSV file is needed. Never enter a password or app secret here.':'Reload calendar connections to check whether secure provider setup is ready.'));
        if(typeof membership!=='undefined'&&membership?.isAdmin&&provider){
          const details=node('details');details.append(node('summary','Administrator setup: where to start'),note('Do this once for the app, not once per farmer. You can set up one provider first. Stop if a portal requires a paid upgrade or permissions you do not have.'));
          const steps=node('ol');
          const instructions=id==='outlook'?[
            'Open Microsoft Entra admin center → App registrations → New registration. Use a separate Farmer Daily Calendar registration.',
            'Choose accounts in any organizational directory and personal Microsoft accounts. Add the redirect below as a Web redirect URI.',
            'Under API permissions, add Microsoft Graph delegated User.Read and Calendars.ReadWrite. Do not add mail permissions or application-wide permissions.',
            'Create a client secret under Certificates & secrets. Its Value, not its Secret ID, belongs in the server settings. Keep it private.'
          ]:[
            'Open Google Cloud Console and select or create a project. Enable the Google Calendar API in APIs & Services → Library.',
            'Open Google Auth Platform. Complete Branding, choose External under Audience, and add your own Google account as a test user while Testing.',
            'In Data Access, use calendar.app.created, openid and email. Do not request access to existing calendars or Gmail.',
            'In Clients, create a Web application client and add the exact redirect below. Its client secret belongs only in server settings. Google may require review before public use.'
          ];
          for(const instruction of instructions)steps.append(node('li',instruction));details.append(steps,link(id==='outlook'?'Open Microsoft Entra admin center':'Open Google Cloud Console',id==='outlook'?'https://entra.microsoft.com/':'https://console.cloud.google.com/'),note('Exact production redirect URI:'),node('p',`https://calm-desert-02e51f41e.1.azurestaticapps.net/calendar-callback/${id}`,'calendar-copy-value'),note('In Azure Portal, open Static Web Apps → farmer-daily-prod-j6yft7bqkpyxk → Settings → Environment variables (or Configuration / Application settings). Save the provider client ID and secret under the exact server setting names below. The shared public app URL and encryption key are also required; follow CALENDAR_SETUP.md in the project for those.'));
          if(Array.isArray(provider.setupRequired)&&provider.setupRequired.length){details.append(note('Missing server setting names — never paste secret values into this app or a chat:'));const names=node('ul');for(const name of provider.setupRequired)if(typeof name==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(name))names.append(node('li',name));details.append(names);}
          details.append(link('Official provider setup instructions',id==='outlook'?'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app':'https://developers.google.com/identity/protocols/oauth2/web-server'),link('Official Azure server settings instructions','https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings'),note('After saving server settings, reload connections. The Connect button starts your own sign-in and permission review; this setup does not connect an account by itself.'));card.append(details);
        }
      }
      if(!provider?.connected||provider?.needsReconnect){
        const scope=id==='google'?'Google grants access to secondary calendars this app creates, not your existing calendars.':'Microsoft asks for calendar read/write permission and basic profile access. That permission is broader than this feature; Farmer Daily uses it only for its own secondary calendar.';
        card.append(note(scope),checkbox(`calendarConsent-${id}`,`I allow Farmer Daily to create a separate Farmer Daily calendar in ${providers[id].name}. Events will be added only after I approve each one.`));
        card.append(actionButton(provider?.needsReconnect?`Reconnect ${providers[id].name}`:`Connect ${providers[id].name}`,'connect',()=>connect(id),{id:`calendarConnect-${id}`,provider:id,primary:true}));
      }
      card.append(link('Read the provider permission details',providers[id].permissions));target.append(card);
    }
  }
  function syncTasks(){
    const select=get('calendarTask');if(!select)return;const previous=select.value;select.replaceChildren();const first=node('option','Choose a dated, unfinished farm task');first.value='';select.append(first);
    for(const task of taskList()){if(task.done||!/^\d{4}-\d{2}-\d{2}$/.test(task.date||''))continue;const option=node('option',`${short(task.name)} — ${task.date}${task.time?' at '+task.time:''} (Pacific time)`);option.value=String(task.id);select.append(option);}select.value=previous;updateButtons();
  }
  function facts(parent,items){const list=node('dl',undefined,'calendar-facts');for(const [label,value]of items){const row=node('div');row.append(node('dt',label),node('dd',value));list.append(row);}parent.append(list);}
  function renderProposals(){
    const target=get('calendarProposals');if(!target)return;target.replaceChildren();
    if(!data){target.append(note('Reload connections to view saved calendar proposals.'));return;}
    if(!data.proposals.length){target.append(note('No calendar events prepared. Preparing a proposal does not add an event.'));return;}
    for(const proposal of data.proposals){
      if(!proposal||typeof proposal.id!=='string'||!Object.hasOwn(providers,proposal.provider))continue;
      const preview=proposal.preview||proposal.event||{},provider=providers[proposal.provider],card=node('article',undefined,'calendar-card calendar-proposal');card.dataset.proposalId=proposal.id;
      const isUncertain=uncertain.has(proposal.id)||uncertainStatuses.has(proposal.status),expired=!Number.isFinite(Date.parse(proposal.expiresAt))||Date.parse(proposal.expiresAt)<=Date.now();
      card.append(node('h4',short(preview.title||preview.summary||proposal.title)||'Calendar event'),node('p',isUncertain?'Result unconfirmed':String(proposal.status||'Unknown status'),'calendar-badge'));
      const zone=short(preview.timeZone)||'America/Los_Angeles';
      const start=preview.allDay?short(preview.date):short(preview.startUtc);
      const end=preview.allDay?short(preview.endDate):short(preview.endUtc);
      const eventTime=text=>{if(!text)return 'Not provided';if(preview.allDay)return text;try{return new Intl.DateTimeFormat(undefined,{timeZone:zone,dateStyle:'full',timeStyle:'long'}).format(new Date(text));}catch{return text;}};
      facts(card,[['Provider',provider.name],['Account',short(preview.accountLabel)||'Connected account'],['Calendar',short(proposal.calendarName||preview.calendarName)||'Farmer Daily'],['Title',short(preview.title||preview.summary||proposal.title)||'Not provided'],['Starts',eventTime(start)],['Ends',eventTime(end)],['Time zone',zone],['All day',preview.allDay===true?'Yes — end date is exclusive':'No — one hour']]);
      card.append(note('Only the event details shown here are sent. No attendees are invited and no email is sent. This is a one-time addition, not calendar syncing.'));
      if(isUncertain)card.append(node('p','This event may already exist. Check the Farmer Daily calendar in the provider, then reload connections. Do not create another copy. The app will not automatically retry.','calendar-warning'));
      else if(pendingStatuses.has(proposal.status)){
        card.append(note(expired?'This proposal expired. Prepare a new proposal to review the current task.':`Approve before ${new Date(proposal.expiresAt).toLocaleString()}. The event will not follow later changes to your task.`));
        if(!expired){card.append(checkbox(`calendarApprove-${proposal.id}`,'I reviewed the exact event above and approve adding it to this calendar.'));card.append(actionButton(`Approve and add to ${provider.name}`,'execute',async()=>{if(!checked(`calendarApprove-${proposal.id}`))return;status(`Sending your approved event to ${provider.name}. Do not submit another copy.`);const result=await request('execute',{proposalId:proposal.id,approved:true});if(result)status(uncertainStatuses.has(result.proposal?.status)?'The provider result is not confirmed. Check your calendar and reload connections; do not add another copy.':result.proposal?.status==='executed'||result.proposal?.status==='completed'?`Event added to ${provider.name}. Later task changes will not update it automatically.`:'The recorded calendar result is shown below. No automatic retry will occur.');},{proposal:proposal.id,primary:true}));}
        card.append(actionButton('Cancel calendar proposal','cancel',async()=>{const result=await request('cancel',{proposalId:proposal.id});if(result)status('Calendar proposal cancelled. No event was sent.');},{proposal:proposal.id}));
      }
      if(proposal.message)card.append(note(short(proposal.message)));
      if(proposal.result?.message)card.append(note(short(proposal.result.message)));
      if(terminalStatuses.has(proposal.status))card.append(actionButton('Remove saved calendar proposal','remove',async()=>{if(!confirm('Remove this saved proposal from Farmer Daily? Any event already added to your external calendar is kept. This cannot be undone.'))return;const result=await request('deleteProposal',{proposalId:proposal.id});if(result){if(!result.providers){data.proposals=data.proposals.filter(item=>item.id!==proposal.id);renderProposals();updateButtons();}status('Saved proposal removed. Existing provider calendar events were not deleted.');}},{proposal:proposal.id}));
      target.append(card);
    }
  }
  function renderData(){
    renderProviders();renderProposals();const select=get('calendarProvider');if(select){const previous=select.value;select.replaceChildren();for(const provider of data?.providers||[]){if(!provider.connected||provider.needsReconnect)continue;const option=node('option',providers[provider.id].name);option.value=provider.id;select.append(option);}if([...select.options].some(option=>option.value===previous))select.value=previous;}
    get('calendarAccess').textContent=data&&!data.canConnect?'Frontier Farm approval is required to connect accounts or add events. You can still disconnect an existing account and manage saved proposals.':'Optional: connect either provider or both. Sensors and CSV imports are not required.';syncTasks();updateButtons();
  }
  function mount(){
    const page=get('connectedPage');if(!page||get('calendarConnections'))return;
    const root=node('section',undefined,'calendar-connections');root.id='calendarConnections';root.setAttribute('aria-labelledby','calendarConnectionsHeading');const heading=node('h3','Connect Outlook or Google Calendar');heading.id='calendarConnectionsHeading';
    root.append(heading,note('Calendar-only connection: add a saved farm task after reviewing and approving its exact event. This does not connect email, read your inbox, send invitations, or automatically sync your calendar.'),note('Events are marked private in a separate Farmer Daily calendar. Your provider and organization sharing policies still apply.'));
    const returnMessages={connected:'Provider sign-in completed. Check the connection status below before adding any event.',cancelled:'Calendar connection was cancelled. No event was added.',failed:'The calendar connection did not finish. Reload connections to check whether a calendar was created before trying again.',expired:'The calendar sign-in attempt expired. Reload connections before starting again.'};
    const parameters=new URLSearchParams(location.search),returned=parameters.get('calendar');if(owner()&&Object.hasOwn(returnMessages,returned)){const message=node('p',returnMessages[returned],returned==='connected'?'calendar-status':'calendar-warning');message.id='calendarReturnStatus';message.setAttribute('role','status');root.append(message);parameters.delete('calendar');history.replaceState(null,'',`${location.pathname}${parameters.toString()?'?'+parameters.toString():''}${location.hash}`);}
    const access=note('');access.id='calendarAccess';root.append(access);
    const message=node('p','','calendar-status');message.id='calendarStatus';message.setAttribute('role','status');message.setAttribute('aria-live','polite');root.append(message,actionButton('Reload calendar connections','reload',reload,{id:'calendarReload'}));
    root.append(Object.assign(node('div',undefined,'calendar-provider-grid'),{id:'calendarProviders'}));
    const form=node('form',undefined,'calendar-event-form');form.id='calendarPrepareForm';form.append(node('h4','Add a farm task to your calendar'),note('1. Choose a dated task and connected provider. 2. Prepare its exact event. 3. Review and approve below. Nothing is sent at step 2.'));
    for(const [id,label]of [['calendarTask','Farm task'],['calendarProvider','Connected calendar provider']]){const wrap=node('label',label),select=node('select');select.id=id;select.onchange=updateButtons;wrap.append(select);form.append(wrap);}
    const prepare=actionButton('Prepare calendar event — do not send yet','prepare',null,{id:'calendarPrepare',primary:true});prepare.type='submit';form.append(prepare);form.onsubmit=async event=>{event.preventDefault();const provider=get('calendarProvider').value,taskId=get('calendarTask').value;if(!Object.hasOwn(providers,provider)||!taskId)return;status('Saving your farm tasks, then preparing an event for your review.');const result=await request('prepare',{provider,taskId});if(result){status('Event prepared. Review the exact details below and approve only if they are correct. Nothing has been sent to your calendar.');get('calendarProposals').scrollIntoView({block:'start'});}};root.append(form,node('h4','Calendar proposals and results'),Object.assign(node('div'),{id:'calendarProposals'}));page.insertBefore(root,get('connectedFarm'));renderData();
  }
  function render(){
    const expected=owner();if(expected!==cacheOwner){clear();cacheOwner=expected;}mount();
    if(!get('calendarConnections'))return;
    if(!expected){status('Sign in and reconnect your private farm before managing calendar connections.');get('calendarPrepareForm').hidden=true;}
    else get('calendarPrepareForm').hidden=false;
    syncTasks();updateButtons();
  }
  async function open(){render();if(owner()&&!loaded&&!busy)await reload();}
  window.CalendarConnections={render,open,clear};
  window.addEventListener('storage',event=>{if(event.key==='farmerDailyCloudOwner')render();});
  window.addEventListener('focus',render);
})();
