// Plan and administrator privileges come only from the authenticated server.
let membership = null;
let membershipRefresh = null;
let savedDailyBrief = null;
let savedDailyBriefOwner = null;
let dailyBriefRequest = null;
let dailyBriefGenerating = false;
let queuedDailyBriefRequest = null;
let resolveMembership;
const membershipReady = new Promise(resolve => { resolveMembership = resolve; });

function membershipAllowsPremium() { return membership?.plan === 'premium'; }
function membershipAllowsCore() { return !!membership?.user?.id && ['free','premium'].includes(membership.plan); }
function requireCore() { if (membershipAllowsCore()) return true; showAccountError(new Error('Sign in to open your private farm.')); return false; }

async function memberFetch(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Request timed out'), {name:'AbortError'}));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
    const response = await fetch(url, {...options, credentials:'same-origin', cache:'no-store', redirect:'manual', signal:controller.signal,
      headers:{Accept:'application/json', ...(membership?.user?.id && !(url === '/api/account' && !options.method) ? {'X-Farmer-Account-Id':membership.user.id} : {}), ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 302) {
      const error = new Error('Please sign in again to reconnect your account.'); error.status = 401; throw error;
    }
    let data = null, invalidJson = false;
    if (response.status !== 204) {
      try { data = await response.json(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        invalidJson = true;
      }
    }
    if (!response.ok) {
      const message = response.status === 404 || response.status >= 500
        ? `The account service is temporarily unavailable (HTTP ${response.status}). Please retry in a moment.`
        : typeof data?.error === 'string' ? data.error : `The account service could not complete this request (HTTP ${response.status}). Please retry.`;
      const error = new Error(message); error.status = response.status; throw error;
    }
    if (invalidJson) throw new Error('The account service returned an unexpected response. Please retry in a moment.');
    return data;
    })()]);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The account service took too long to respond. Please retry.');
    if (error.name === 'TypeError') throw new Error('Could not connect to the account service. Check your connection and retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function showAccountError(error) {
  window.FarmerBriefVoice?.clear();
  window.FarmerAiBrief?.clear();
  window.ConnectedFarm?.clear();
  window.FarmerMessaging?.clear();
  document.querySelector('#accountGate').hidden = false;
  document.querySelector('.shell').inert = true;
  document.querySelector('#accountGateMessage').textContent = error?.message || 'Your account could not be loaded.';
  document.querySelector('#accountRetryBtn').hidden = false;
  document.querySelector('#accountSignIn').hidden = error?.status !== 401;
}

function renderMembership() {
  if (!membership) return;
  const premium = membershipAllowsPremium(), request = membership.request;
  document.body.dataset.membership = premium ? 'premium' : 'free';
  document.querySelector('#accountPlanLabel').textContent = membership.isAdmin ? 'Admin · Frontier Farm' : premium ? 'Frontier Farm · approved' : 'Farmer Daily · Free';
  document.querySelector('#accountEmail').textContent = membership.user.email;
  document.querySelector('#adminNavLink').hidden = !membership.isAdmin;
  document.querySelector('#planTitle').textContent = 'Farmer Daily is free';
  document.querySelector('#planDescription').textContent = 'Farm setup, maps, field weather, tasks, briefs and available field-context/satellite tools are free. Some sources need provider setup. Approved Frontier Farm adds private equipment/readings/knowledge and reviewed internal workflows, with no payment.';
  document.querySelector('#premiumRequestForm').hidden = premium || request?.status === 'pending';
  document.querySelector('#premiumRequestStatus').textContent = premium ? (membership.isAdmin ? 'Your administrator account includes Frontier Farm early access.' : 'Your Frontier Farm request was approved.') : request?.status === 'pending' ? 'Request sent. Your free field tools remain available while an admin reviews Frontier Farm access.' : request?.status === 'declined' ? 'Your last Frontier Farm request was declined. You can request again; Farmer Daily stays free.' : 'No payment information is needed. Sensors, equipment, and licensed integrations are not connected.';
  document.querySelector('#dailyBriefRefreshBtn').hidden = false;
  document.querySelector('#dailyBriefLimit').textContent = 'A saved daily snapshot · refresh available to everyone · Pacific time';
  for (const element of document.querySelectorAll('[data-premium-page]')) {
    element.setAttribute('aria-label', `${element.dataset.premiumPage}${premium ? '' : ' — Frontier Farm approval required'}`);
  }
}

async function refreshMembership(initial = false) {
  if (membershipRefresh) return membershipRefresh;
  membershipRefresh = (async () => {
    try {
      const account = await memberFetch('/api/account');
      if (!account?.user?.id || !['free','premium'].includes(account.plan) || typeof account.isAdmin !== 'boolean') throw new Error('The account service returned an incomplete response. Please retry in a moment.');
      // Admins land in administration before farm-profile loading or onboarding.
      // This preference never grants access: /api/account and /api/admin own authorization.
      if (initial && account.isAdmin === true && new URLSearchParams(location.search).get('view') !== 'farmer') {
        document.querySelector('.shell').inert = true;
        document.querySelector('#accountGate').hidden = false;
        document.querySelector('#accountGateMessage').textContent = 'Opening your admin portal…';
        resolveMembership(null);
        location.replace('/admin.html');
        return account;
      }
      if (membership && (membership.user.id !== account.user.id || membership.plan !== account.plan)) { window.FarmerBriefVoice?.clear();window.ConnectedFarm?.clear();window.FarmerAiBrief?.clear();location.reload(); return null; }
      const previousDate=membership?.date;
      membership = account;
      renderMembership();
      if(previousDate&&previousDate!==account.date)loadDailyBrief();
      if (initial) resolveMembership(account);
      return account;
    } catch (error) {
      if (initial || error.status === 401) showAccountError(error);
      else document.querySelector('#premiumRequestStatus').textContent = 'Account refresh paused. Your approval status will refresh when the connection returns.';
      if (initial) resolveMembership(null);
      return null;
    } finally { membershipRefresh = null; }
  })();
  return membershipRefresh;
}

function requirePremium() {
  if (membershipAllowsPremium()) return true;
  if (typeof openPage === 'function') openPage('settings');
  window.FarmerFocusedViews?.reveal('#planPanel');
  document.querySelector('#planPanel').scrollIntoView({behavior:'smooth',block:'center'});
  document.querySelector('#premiumRequestStatus').textContent = membership?.request?.status === 'pending' ? 'Your Frontier Farm request is waiting for an admin.' : 'Request free Frontier Farm early access to use this feature.';
  return false;
}

function renderDailyBrief(brief) {
  savedDailyBrief = brief;
  savedDailyBriefOwner = membership?.user?.id || null;
  window.syncBriefVoiceContext?.();
  window.FarmerAiBrief?.sync();
  const summary = document.querySelector('#dailyBriefSummary'), items = document.querySelector('#dailyBriefItems');
  items.replaceChildren();
  document.querySelector('#dailyBriefListenBtn').hidden = !brief || !!brief.deleted;
  if (!brief || brief.deleted) {
    document.querySelector('#briefCoverage')?.replaceChildren();
    document.querySelector('#dailyBriefHeading').textContent='Your daily field brief';
    summary.textContent = brief?.deleted ? 'This saved brief was removed with your farm data. Save your farm setup before preparing another.' : 'Add your fields, then get up to three weather and task priorities backed by your actual data.';
    document.querySelector('#dailyBriefDate').textContent = brief?.date || 'READY WHEN YOU ARE';
    document.querySelector('#dailyBriefBtn').hidden = false;
    document.querySelector('#dailyBriefBtn').textContent = 'Get today’s brief';
    document.querySelector('#dailyBriefCredit').replaceChildren();
    return;
  }
  summary.textContent = brief.summary;
  document.querySelector('#dailyBriefDate').textContent = `${brief.date} · Saved ${new Date(brief.createdAt).toLocaleTimeString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}`;
  for (const text of brief.items || []) { const li=document.createElement('li'); li.textContent=text; items.appendChild(li); }
  if (Array.isArray(brief.advisories)) window.PhaseOne?.renderAdvisories(brief);
  document.querySelector('#dailyBriefBtn').hidden = true;
  const credit = document.querySelector('#dailyBriefCredit'); credit.replaceChildren();
  const weather = brief.weather;
  if (weather?.source) {
    const backup=weather.source.id==='open-meteo', link=document.createElement('a');
    const place=waLocations[brief.locationId];
    link.href=backup?'https://open-meteo.com/':place?`https://forecast.weather.gov/MapClick.php?lat=${place[1]}&lon=${place[2]}`:'https://www.weather.gov/';
    link.textContent=backup?'Weather data by Open-Meteo':'NOAA / National Weather Service';link.target='_blank';link.rel='noopener noreferrer';credit.appendChild(link);
    if(backup){const licence=document.createElement('a');licence.href='https://creativecommons.org/licenses/by/4.0/';licence.textContent='CC BY 4.0 · wording and units adapted';licence.target='_blank';licence.rel='noopener noreferrer';credit.append(document.createTextNode(' · '),licence);}
    credit.append(document.createTextNode(` · ${weather.stale?'Saved weather · ':''}${weather.updated?'Issued':'Retrieved'} ${new Date(weather.updated||weather.fetchedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}`));
  }
}

async function loadDailyBrief(generate = false, refresh = false) {
  if(queuedDailyBriefRequest)return queuedDailyBriefRequest;
  if(dailyBriefRequest){
    // Repeated clicks and the scheduler join the same build. If the initial
    // saved-brief read is still running, queue at most one requested build.
    if(!generate||dailyBriefGenerating)return dailyBriefRequest;
    const expected=membership?.user?.id;
    queuedDailyBriefRequest=(async()=>{
      try{
        await waitForBriefStage(dailyBriefRequest,5000,'Your saved brief is still loading. Please retry in a moment.');
        if(!cloudEnabled||membership?.user?.id!==expected)return;
        dailyBriefGenerating=true;
        dailyBriefRequest=performDailyBriefRequest(generate,refresh).finally(()=>{dailyBriefRequest=null;dailyBriefGenerating=false;});
        return await dailyBriefRequest;
      }catch(error){if(membership?.user?.id===expected)document.querySelector('#dailyBriefStatus').textContent=error.message;}
      finally{queuedDailyBriefRequest=null;}
    })();
    return queuedDailyBriefRequest;
  }
  dailyBriefGenerating=generate;
  dailyBriefRequest=performDailyBriefRequest(generate,refresh).finally(()=>{dailyBriefRequest=null;dailyBriefGenerating=false;});
  return dailyBriefRequest;
}
function waitForBriefStage(promise, timeoutMs, message){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),timeoutMs);})]).finally(()=>clearTimeout(timer));
}
async function performDailyBriefRequest(generate = false, refresh = false) {
  const expected=membership?.user?.id;
  const status=document.querySelector('#dailyBriefStatus');
  const buttons=[document.querySelector('#dailyBriefBtn'),document.querySelector('#dailyBriefRefreshBtn')];
  if(!expected||!cloudEnabled)return;
  if(generate&&!profile){openProfileEditor();return;}
  buttons.forEach(button=>{button.disabled=true;});status.textContent=generate?'Saving your farm before building the brief…':'Loading your saved brief…';
  try {
    if(generate){
      let preflightActive=true,saved=false;
      try{
        saved=await waitForBriefStage((async()=>{
          // Edits made while the first save waits must be synchronized too.
          // All passes share one deadline; timing out must not schedule a late
          // save or brief after the controls have been released.
          while(preflightActive&&cloudEnabled&&membership?.user?.id===expected){
            const synchronized=await saveCloudState();
            if(!preflightActive||!cloudEnabled||membership?.user?.id!==expected||!synchronized)return false;
            if(JSON.stringify(collectCloudState())===lastCloudPayload)return true;
          }
          return false;
        })(),10000,'Farm sync is taking too long. Your device changes were kept. Wait for sync, then retry your brief.');
      }finally{preflightActive=false;}
      if(!cloudEnabled||membership?.user?.id!==expected)return;
      if(!saved)throw new Error('Your farm could not sync. Your device changes were kept; check your connection and retry.');
      status.textContent='Checking field weather and tasks… Your saved brief stays available.';
    }
    const data=await memberFetch('/api/brief',generate?{method:'POST',body:JSON.stringify({refresh:!!refresh})}:{});
    if(membership?.user?.id!==expected||!cloudEnabled)return;
    renderDailyBrief(data.deleted ? {deleted:true,date:data.date} : data.brief);
    status.textContent=data.deleted?'Saved brief content was deleted. Complete farm setup to prepare another.':data.brief?(data.reused?'Your saved brief is ready. Refresh checks for new priorities after at least one minute.':'Your daily brief is ready.'):'Choose “Get today’s brief” when you are ready.';
    return data;
  } catch(error){if(membership?.user?.id===expected){status.textContent=error.message;if(error.status===401)showAccountError(error);}}
  finally{buttons.forEach(button=>{button.disabled=false;});}
}

function finishAccountBoot() {
  renderMembership();
  document.querySelector('.shell').inert=false;
  document.querySelector('#accountGate').hidden=true;
  loadDailyBrief();
  if(membershipAllowsCore())loadForecast();
  const page=location.hash.slice(1)||'today';
  openPage(page,false);
  window.PhaseOne?.boot();
  window.FarmerIntelligence?.boot();
}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('.shell').inert=true;
  document.querySelector('#accountRetryBtn').onclick=()=>location.reload();
  document.querySelector('#refreshPlanBtn').onclick=()=>refreshMembership();
  document.querySelector('#dailyBriefBtn').onclick=()=>loadDailyBrief(true);
  document.querySelector('#dailyBriefRefreshBtn').onclick=()=>loadDailyBrief(true,true);
  document.querySelector('#dailyBriefListenBtn').onclick=()=>{
    if(requireCore())window.PhaseOne?.speakBrief();
  };
  document.querySelector('#premiumRequestForm').onsubmit=async event=>{
    event.preventDefault();const button=document.querySelector('#requestPremiumBtn');button.disabled=true;
    try{await memberFetch('/api/account',{method:'POST',body:JSON.stringify({action:'request-premium',reason:document.querySelector('#premiumReason').value.trim()})});await refreshMembership();}
    catch(error){document.querySelector('#premiumRequestStatus').textContent=error.message;}
    finally{button.disabled=false;}
  };
  refreshMembership(true);
});

// UI guard complements the server's checks on every protected API.
for (const eventName of ['click','submit','change']) document.addEventListener(eventName,event=>{
  if (!membershipAllowsPremium() && event.target.closest?.('.premium-feature')) {
    event.preventDefault();event.stopImmediatePropagation();requirePremium();
  }
},true);

window.addEventListener('online',()=>{if(membership)refreshMembership();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&membership)refreshMembership();});
setInterval(()=>{if(!document.hidden&&membership)refreshMembership();},60000);
