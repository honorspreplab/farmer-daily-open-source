'use strict';
// A field is a draft until the farmer reviews it and chooses the final Save.
(() => {
  const get=id=>document.getElementById(id),form=get('fieldForm'),dialog=get('fieldDialog');
  if(!form||!dialog||!window.FarmerFieldMap||!get('fieldName')?.closest('label'))return;
  const node=(tag,text,className)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;if(className)item.className=className;return item;};
  const button=(text,id,fn,className='secondary')=>{const item=node('button',text,className);item.id=id;item.type='button';item.onclick=fn;return item;};
  let step=1,editing=null,busy=false,confirmationVersion=0,confirmationOwner=null;
  const account=()=>cloudEnabled&&membership?.user?.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;

  dialog.classList.add('field-guided-dialog');form.noValidate=true;
  const title=get('fieldDialogTitle'),eyebrow=form.querySelector('.eyebrow');
  const header=node('header',undefined,'field-flow-header');header.append(eyebrow,title);
  const steps=node('ol',undefined,'field-flow-steps');steps.setAttribute('aria-label','Add field progress');
  for(const [index,label]of ['Name & crop','Location','Review & save'].entries()){const item=node('li',`${index+1}. ${label}`);item.dataset.step=String(index+1);steps.append(item);}header.append(steps);
  const body=node('div',undefined,'field-flow-body');body.id='fieldFlowBody';
  const panels=[1,2,3].map(value=>{const panel=node('section');panel.id=`fieldFlowStep${value}`;panel.hidden=value!==1;body.append(panel);return panel;});
  // Keep moved controls connected so the existing editor can resolve their IDs.
  form.append(header,body);
  panels[0].append(node('h3','What do you call this field?'),node('p','Give it a name you recognize and tell us what grows here. You can change these later.','workspace-note'),form.querySelector('.field-core-fields'));
  const locationEditor=get('fieldLocationEditor');panels[1].append(locationEditor);
  locationEditor.querySelector('h3').textContent='Choose where your field is';
  const readingMapJump=button('Go to map','fieldReadingMapJump',()=>{
    const consent=get('fieldEditorMapConsent'),target=consent&&!consent.hidden?consent:get('fieldEditorMap');
    window.FarmerFocusedViews?.reveal(target);
    target?.scrollIntoView({block:'start',behavior:'instant'});
  },'secondary reading-map-shortcut');
  readingMapJump.setAttribute('aria-controls','fieldEditorMap');locationEditor.querySelector('h3').after(readingMapJump);
  locationEditor.querySelector('p.workspace-note').textContent='Load the map and zoom to your field. Tap once for a field point, or choose Draw boundary and tap at least three corners. The next button will take you to review.';
  panels[2].append(node('h3','Review your field before saving'),node('p','Check the details below. Nothing is saved until you choose Save field.','workspace-note'));
  const review=node('dl',undefined,'field-review-summary');review.id='fieldReviewSummary';panels[2].append(review);
  const consent=get('fieldDataConsent').closest('label'),privacy=consent.nextElementSibling;
  panels[2].append(node('h4','Field weather and elevation'),consent);if(privacy)panels[2].append(privacy);panels[2].append(get('fieldCropDetails'));
  const oldActions=form.querySelector('.modal-actions'),cancel=get('cancelFieldBtn');cancel.textContent='Cancel';oldActions.remove();
  const originalError=get('fieldError');originalError.hidden=true;
  const footer=node('footer',undefined,'field-flow-footer');footer.id='fieldFlowFooter';
  const status=node('p','','field-flow-status');status.id='fieldFlowStatus';status.setAttribute('role','status');
  const error=node('p','','field-flow-error');error.id='fieldFlowError';error.setAttribute('role','alert');error.hidden=true;
  const actions=node('div',undefined,'field-flow-actions'),back=button('Back','fieldFlowBack',()=>showStep(Math.max(1,step-1))),next=button('Next: locate field','fieldFlowNext',advance,'primary');
  actions.append(cancel,back,next);footer.append(status,error,actions);form.append(header,body,footer);
  next.setAttribute('aria-describedby','fieldFlowStatus fieldFlowError');

  const confirmation=node('section',undefined,'field-save-confirmation');confirmation.id='fieldSaveConfirmation';confirmation.hidden=true;confirmation.setAttribute('role','status');get('workspaceMessage').after(confirmation);
  function clearError(){error.textContent='';error.hidden=true;originalError.textContent='';for(const input of form.querySelectorAll('[aria-invalid]'))input.removeAttribute('aria-invalid');}
  function showError(message,target){error.textContent=message;error.hidden=false;if(target){target.setAttribute('aria-invalid','true');let details=target.closest('details');while(details){details.open=true;details=details.parentElement.closest('details');}target.focus();}}
  function validateIdentity(){
    for(const [id,label]of [['fieldName','a field name'],['fieldCrop','a crop or use']]){const input=get(id);if(!input.value.trim()){showStep(1);showError(`Enter ${label} before continuing.`,input);return false;}}
    const duplicate=window.FarmerWorkspace.getFields().some(field=>field.id!==editing?.id&&field.name.toLowerCase()===get('fieldName').value.trim().toLowerCase());
    if(duplicate){showStep(1);showError('That field name is already in your farm. Choose another name or edit the existing field.',get('fieldName'));return false;}
    return true;
  }
  function refresh(){
    const draft=window.FarmerFieldMap.draftStatus();
    back.hidden=step===1;next.disabled=busy;cancel.disabled=busy;back.disabled=busy;
    next.textContent=busy?'Saving field…':step===1?'Next: locate field':step===2&&draft.kind==='drawing'&&draft.corners>=3?'Finish drawing & review':step===2?'Next: review field':editing?'Save changes':'Save field';
    status.textContent=step===1?'Step 1 of 3 · Nothing is saved yet.':step===2?draft.kind==='drawing'?`${draft.corners} corners added. ${draft.corners<3?`Add ${3-draft.corners} more to make a boundary.`:'Finish drawing & review closes the shape; it does not save the field.'}`:draft.kind==='boundary'?'Boundary ready — not saved yet. Next, review your field.':draft.kind==='point'?'Field point selected — not saved yet. Next, review your field.':editing?'No location recorded. Add one now, or keep this existing field without field weather.':'Select a field point or draw a boundary before continuing.':editing?'Review your changes, then choose Save changes.':'Ready to add this field? Choose Save field.';
    if(step===3)renderReview();
  }
  function renderReview(){
    review.replaceChildren();let data;try{data=window.FarmerFieldMap.readValue();}catch{return;}
    const lines=[['Field name',get('fieldName').value.trim()],['Crop or use',get('fieldCrop').value.trim()],['Location',data.boundary?`Boundary · ${data.boundary.coordinates[0].length-1} corners`:data.location?'Single field point':'No location yet'],['Coordinates',data.location?`${data.location.latitude.toFixed(5)}, ${data.location.longitude.toFixed(5)}`:'Not provided'],['Weather & elevation',data.dataConsent?'Allowed after saving':'Off — no field coordinates shared with data tools']];
    for(const [name,value]of lines){review.append(node('dt',name),node('dd',value));}
  }
  function showStep(value){
    step=value;dialog.dataset.step=String(value);panels.forEach((panel,index)=>panel.hidden=index+1!==step);
    for(const item of steps.children){if(Number(item.dataset.step)===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');item.dataset.complete=String(Number(item.dataset.step)<step);}
    clearError();body.scrollTop=0;refresh();
    if(step===2)requestAnimationFrame(()=>window.FarmerFieldMap.refreshEditor());
  }
  function advance(){
    if(busy)return;clearError();
    if(!validateIdentity())return;
    if(step===1){showStep(2);return;}
    if(step===2){
      try{const draft=window.FarmerFieldMap.draftStatus();if(draft.kind==='none'&&!editing)throw new Error('Choose a field location first. Tap the map for a point, draw a boundary, or enter exact coordinates.');if(draft.kind==='drawing'){if(draft.corners<3)throw new Error(`Add ${3-draft.corners} more boundary corners, or choose Select point instead.`);window.FarmerFieldMap.finishForReview();}window.FarmerFieldMap.readValue();showStep(3);}
      catch(problem){showError(problem.message);}
      return;
    }
    form.requestSubmit();
  }
  // Enter follows the visible step; hidden future controls cannot silently save.
  form.addEventListener('submit',event=>{
    if(step!==3){event.preventDefault();event.stopImmediatePropagation();advance();return;}
    if(busy){event.preventDefault();event.stopImmediatePropagation();return;}
    if(!validateIdentity()){event.preventDefault();event.stopImmediatePropagation();return;}
    try{window.FarmerFieldMap.readValue();}catch(problem){event.preventDefault();event.stopImmediatePropagation();showStep(2);showError(problem.message);return;}
    for(const input of form.querySelectorAll('input')){if(input.willValidate&&!input.validity.valid){event.preventDefault();event.stopImmediatePropagation();showStep(input.closest('#fieldFlowStep1')?1:input.closest('#fieldFlowStep2')?2:3);showError(input.validationMessage,input);return;}}
    busy=true;refresh();
  },true);
  form.addEventListener('input',()=>{if(!busy){clearError();refresh();}});
  form.addEventListener('change',()=>{if(!busy)refresh();});
  form.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target instanceof HTMLInputElement&&['text','number'].includes(event.target.type)){event.preventDefault();advance();}});
  window.addEventListener('field-draft-changed',()=>{if(dialog.open){clearError();refresh();}});
  dialog.addEventListener('close',()=>{busy=false;});
  new MutationObserver(()=>{if(originalError.textContent&&dialog.open){busy=false;showError(originalError.textContent);refresh();}}).observe(originalError,{childList:true,subtree:true,characterData:true});

  function open(field){editing=field||null;busy=false;confirmationVersion++;confirmation.hidden=true;showStep(1);}
  function failure(message){busy=false;showError(message);refresh();}
  function resetConfirmation(){if(confirmationOwner!==account()){confirmation.hidden=true;confirmation.replaceChildren();confirmationVersion++;confirmationOwner=null;}}
  async function saved(field){
    const expected=account();if(!expected)return;const token=++confirmationVersion;confirmationOwner=expected;
    const unchanged=()=>token===confirmationVersion&&account()===expected&&window.FarmerWorkspace.getFields().some(item=>item.id===field.id);
    confirmation.replaceChildren();confirmation.hidden=false;
    const heading=node('h3',`${field.name} is now in your fields`),message=node('p','Saved on this device. Syncing to your private account…');
    const controls=node('div',undefined,'workspace-actions'),again=button('Add another field','fieldAddAnother',()=>get('addFieldBtn').click()),retry=button('Retry cloud sync','fieldRetrySync',sync);
    retry.hidden=true;controls.append(again,retry);confirmation.append(heading,message,controls);
    async function sync(){retry.disabled=true;let result=false;try{result=await saveCloudState();}catch{}if(!unchanged())return;message.textContent=result?'Saved to your private account. You can reopen this field from the list below.':'Saved on this device only. Cloud sync is paused—keep this device copy and retry when connected.';retry.hidden=result;retry.disabled=false;}
    await sync();
  }
  window.FarmerFieldFlow={open,saved,failure,resetConfirmation};
  refresh();
})();
