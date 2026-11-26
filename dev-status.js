'use strict';
(() => {
  const get=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  async function load(){
    get('devContent').hidden=true;get('devRetry').disabled=true;get('devMessage').textContent='Checking administrator access…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('/api/build-status',{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal,headers:{Accept:'application/json'}});
      if(response.type==='opaqueredirect'||[0,302,401].includes(response.status))throw new Error('Sign in with an administrator account, then retry.');
      if(response.status===403)throw new Error('This page is available only to administrators.');
      if(!response.ok)throw new Error('Build status is temporarily unavailable. Please retry.');
      const data=await response.json();if(!Array.isArray(data.features))throw new Error('Unexpected build status response.');
      get('devRelease').textContent=`Release ${data.version}`;get('devPhases').replaceChildren();
      for(let phase=0;phase<=5;phase++){
        const section=node('section',''),items=data.features.filter(item=>item.phase===phase),validated=items.filter(item=>item.status==='Validated').length;
        section.append(node('h2',`Phase ${phase} · ${validated}/${items.length} capabilities validated`));
        for(const item of items){const row=node('div','');row.className='intelligence-row';const copy=node('div','');copy.append(node('b',item.name),node('p',item.detail));const badge=node('span',item.status);badge.className='maturity-badge';badge.dataset.status=item.status;row.append(copy,badge);section.append(row);}get('devPhases').append(section);
      }
      get('devLimits').replaceChildren();for(const limitation of data.limitations||[])get('devLimits').append(node('li',limitation));get('devContent').hidden=false;get('devMessage').textContent='Administrator access confirmed.';
    }catch(error){get('devMessage').textContent=error.name==='AbortError'?'Connection timed out. Please retry.':error.message;}finally{clearTimeout(timer);get('devRetry').disabled=false;}
  }
  get('devRetry').onclick=load;load();
})();
