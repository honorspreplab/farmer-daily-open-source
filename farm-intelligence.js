'use strict';

// Private, owner-scoped views of measured/contextual data. No provider query is
// made merely by opening this page, and no proposed task is saved automatically.
(() => {
  const get = id => document.getElementById(id);
  const node = (tag, text, className) => { const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(className)item.className=className;return item; };
  const button = (text, action, className='secondary') => { const item=node('button',text,className);item.type='button';item.onclick=action;return item; };
  const finite = value => typeof value==='number'&&Number.isFinite(value);
  const list = (value, maximum=20) => Array.isArray(value)?value.slice(0,maximum):[];
  const label = (value, fallback='Not reported') => typeof value==='string'&&value.trim()?value.slice(0,500):finite(value)?String(value):fallback;
  const number = (value, suffix='', digits=2) => finite(value)?`${Number(value.toFixed(digits))}${suffix}`:'Not reported';
  const time = value => Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not reported';
  const date = value => Number.isFinite(Date.parse(value))?new Date(value).toLocaleDateString(undefined,{timeZone:'UTC',year:'numeric',month:'short',day:'numeric'}):'Date not reported';
  const allFields = () => window.FarmerWorkspace?.getFields()||[];
  const owner = () => typeof membershipAllowsCore==='function'&&membershipAllowsCore()&&cloudEnabled&&membership?.user?.id===localStorage.getItem('farmerDailyCloudOwner')?membership.user.id:null;
  const signature = field => JSON.stringify({location:field.location,boundary:field.boundary,crop:field.crop,contextConsent:field.contextConsent===true,satelliteConsent:field.satelliteConsent===true,landsatConsent:field.landsatConsent===true,marketReportId:field.marketReportId||'',marketLabel:field.marketLabel||''});
  const selected = () => allFields().find(field=>field.id===selectedId);
  const cache = new Map(),requests = new Map();
  let mounted=false,cacheOwner=null,selectedId='',viewSignature='',saving=false,generation=0;

  function sourceLink(source) {
    try {
      const url=new URL(source?.url||source?.sourceUrl),host=url.hostname;
      const domains=['usda.gov','airnow.gov','airnowapi.org','ecology.wa.gov','lni.wa.gov','planetarycomputer.microsoft.com','dataspace.copernicus.eu','earth-search.aws.element84.com','element84.com','sentinel.esa.int','usgs.gov','nasa.gov'];
      if(url.protocol!=='https:'||url.port||url.username||url.password||!domains.some(domain=>host===domain||host.endsWith('.'+domain)))return null;
      const a=node('a',label(source.name,host));a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';return a;
    }catch{return null;}
  }
  function metadata(container,part,{timely=false}={}) {
    const meta=node('div',undefined,'fi-source');
    const link=sourceLink(part?.source);if(link)meta.append(link);else if(part?.source?.name)meta.append(node('span',label(part.source.name)));
    if(part?.fetchedAt)meta.append(node('span',`Retrieved ${time(part.fetchedAt)}`));
    if(part?.validUntil)meta.append(node('span',`Cache valid until ${time(part.validUntil)}`));
    container.append(meta);
    const expired=part?.validUntil&&(!Number.isFinite(Date.parse(part.validUntil))||Date.parse(part.validUntil)<=Date.now());
    const old=timely&&part?.fetchedAt&&Date.now()-Date.parse(part.fetchedAt)>86400000;
    if(expired||old)container.append(node('p','Saved information is out of date. Refresh and check the source before using it.','fi-warning'));
  }
  function pair(container,name,value){const row=node('div',undefined,'fi-pair');row.append(node('dt',name),node('dd',value));container.append(row);}
  function detailsCard(title,part,key) {
    const card=node('article',undefined,'fi-card');card.dataset.source=key;
    const heading=node('div',undefined,'fi-card-heading');heading.append(node('h3',title));
    const states={ready:'Data available',cached:'Cached data',live:'Data available',unavailable:'Unavailable',needs_configuration:'Admin setup needed',not_selected:'Choose a report',not_connected:'Not connected',no_data:'No matching data',insufficient:'Not enough usable data'};
    const badge=node('span',states[part?.status]||'Not loaded','fi-badge');badge.dataset.status=part?.status||'not_loaded';heading.append(badge);card.append(heading);
    if(part?.message)card.append(node('p',label(part.message)));
    if(part?.status==='needs_configuration')card.append(node('p','An app administrator must connect this source. Never enter an API key or password in these field settings.','fi-note'));
    metadata(card,part,{timely:['markets','air','water'].includes(key)});
    return card;
  }
  function contextCards(field,entry) {
    const target=get('fieldContextCards');target.replaceChildren();
    if(!field.contextConsent){target.append(node('p','Soil, markets, crop statistics, air quality and water context are off for this field. Review the permissions above to connect them.','fi-empty'));return;}
    if(!entry?.data){target.append(node('p',entry?.error||'Choose Refresh farm context to query this field. Sources needing an administrator key are clearly marked.','fi-empty'));return;}
    const result=entry.data;
    const soil=detailsCard('Soil at your field point',result.soil,'soil');
    soil.append(node('p','Soil survey context at one representative point—not a lab test or a whole-field soil map. Check conditions in the field.','fi-note'));
    for(const unit of list(result.soil?.data?.mapUnits,4)){
      soil.append(node('h4',label(unit.name,'Mapped soil unit')));
      for(const component of list(unit.components,4)){
        const dl=node('dl',undefined,'fi-facts');pair(dl,'Component',label(component.name));pair(dl,'Map-unit share',number(component.percent,'%'));pair(dl,'Drainage',label(component.drainage));pair(dl,'Slope',number(component.slopePercent,'%'));
        const horizon=component.topHorizon;if(horizon){pair(dl,'Top horizon',finite(horizon.topCm)&&finite(horizon.bottomCm)?`${horizon.topCm}–${horizon.bottomCm} cm`:'Not reported');pair(dl,'NRCS texture class',label(horizon.texture));pair(dl,'Available water capacity',number(horizon.availableWaterCapacityCmPerCm,' cm/cm',3));pair(dl,'Organic matter',number(horizon.organicMatterPercent,'%'));}soil.append(dl);
      }
    }
    const markets=detailsCard('Your selected market report',result.markets,'markets');
    if(result.markets?.data){markets.append(node('h4',label(result.markets.data.reportLabel,field.marketLabel||`Report ${field.marketReportId||''}`)));for(const item of list(result.markets.data.items,5)){
      const dl=node('dl',undefined,'fi-facts');pair(dl,'Reported',label(item.date));pair(dl,'Commodity / variety',[label(item.commodity,''),label(item.variety,'')].filter(Boolean).join(' · ')||'Not reported');pair(dl,'Market',label(item.market));pair(dl,'Package / unit',[label(item.package,''),label(item.unit,'')].filter(Boolean).join(' · ')||'Not reported');pair(dl,'Grade / size',[label(item.grade,''),label(item.size,'')].filter(Boolean).join(' · ')||'Not reported');pair(dl,'Origin',label(item.origin));pair(dl,'Currency',label(item.currency));pair(dl,'Reported low–high',finite(item.low)&&finite(item.high)?`${item.low}–${item.high}`:'Not reported');pair(dl,'Mostly low–high',finite(item.mostlyLow)&&finite(item.mostlyHigh)?`${item.mostlyLow}–${item.mostlyHigh}`:'Not reported');markets.append(dl);
    }}markets.append(node('p','These are published report quotes in the stated unit—not an offer, your farm’s sale price or investment advice. No change is inferred without comparable reports.','fi-note'));
    const statistics=detailsCard('Washington crop context',result.statistics,'statistics');
    for(const item of list(result.statistics?.data?.items,5)){const dl=node('dl',undefined,'fi-facts');pair(dl,'Statistic',label(item.description));pair(dl,'Year / period',[label(item.year,''),label(item.period,'')].filter(Boolean).join(' · ')||'Not reported');pair(dl,'Published value',`${label(item.value)} ${label(item.unit,'')}`.trim());statistics.append(dl);}
    statistics.append(node('p','Statewide statistics are background context, not instructions for this field. Suppressed values are not estimated.','fi-note'),node('p','This product uses the NASS API but is not endorsed or certified by NASS.','fi-note'));
    const air=detailsCard('Air quality near your field',result.air,'air');
    for(const item of list(result.air?.data?.observations,5)){const dl=node('dl',undefined,'fi-facts');pair(dl,'Pollutant',label(item.pollutant));pair(dl,'AQI (not a concentration)',number(item.aqi,'',0));pair(dl,'Category',label(item.category));pair(dl,'Reporting area',label(item.reportingArea));pair(dl,'Observed',time(item.observedAt));air.append(dl);}
    air.append(node('p','AirNow observations are preliminary reporting-area awareness, not regulatory data, a field sensor or proof of worker-safety compliance.','fi-note'));
    const safety=sourceLink({name:'Check Washington L&I wildfire-smoke requirements',url:'https://www.lni.wa.gov/safety-health/safety-topics/topics/wildfire-smoke'});if(safety)air.append(safety);
    const water=detailsCard('Regional water and drought',result.water,'water');
    if(result.water?.data?.year)water.append(node('p',`Source year: ${label(result.water.data.year)}`));
    for(const item of list(result.water?.data?.areas,5)){const dl=node('dl',undefined,'fi-facts');pair(dl,'Area / watershed',label(item.watershed));pair(dl,'Regional status',label(item.status));water.append(dl);}
    water.append(node('p','Regional drought context does not tell us your irrigation-district allocation, water right or water remaining. No irrigation amount is prescribed.','fi-note'));
    target.append(soil,markets,statistics,air,water);
  }

  function svgNode(tag,attributes={}) {const item=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes))item.setAttribute(key,String(value));return item;}
  function ringOf(geometry){const ring=geometry?.type==='Polygon'&&geometry.coordinates?.[0];return Array.isArray(ring)&&ring.length>=4&&ring.length<=500&&ring.every(point=>Array.isArray(point)&&finite(point[0])&&finite(point[1]))?ring:null;}
  function boundaryView(field,areas,sourceKey='sentinel') {
    const ring=ringOf(field.boundary);if(!ring)return null;
    const figure=node('figure',undefined,'fi-boundary'),svg=svgNode('svg',{viewBox:'0 0 360 260',role:'img','aria-label':`Saved boundary of ${field.name}. Outlined patches mark areas to consider scouting.`});
    const minX=Math.min(...ring.map(p=>p[0])),maxX=Math.max(...ring.map(p=>p[0])),minY=Math.min(...ring.map(p=>p[1])),maxY=Math.max(...ring.map(p=>p[1]));
    const longitudeScale=Math.cos((minY+maxY)/2*Math.PI/180),width=(maxX-minX)*longitudeScale,height=maxY-minY,scale=Math.min(304/(width||1),204/(height||1));
    const x=longitude=>180+(longitude-(minX+maxX)/2)*longitudeScale*scale,y=latitude=>130-(latitude-(minY+maxY)/2)*scale;
    const path=points=>points.map((point,index)=>`${index?'L':'M'}${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`).join(' ')+' Z';
    const clipId=`fiFieldClip-${sourceKey}`,defs=svgNode('defs'),clip=svgNode('clipPath',{id:clipId});clip.append(svgNode('path',{d:path(ring)}));defs.append(clip);svg.append(defs,svgNode('path',{d:path(ring),class:'fi-field-outline'}));
    let count=0;for(const feature of list(areas,128)){const patch=ringOf(feature.geometry);if(patch){svg.append(svgNode('path',{d:path(patch),class:'fi-scout-patch','clip-path':`url(#${clipId})`}));count++;}}
    const north=svgNode('text',{x:16,y:22,class:'fi-north'});north.textContent='N ↑';svg.append(north);figure.append(svg,node('figcaption',count?'Your saved boundary. Dashed patches are change-detection scouting areas, not a diagnosis. North is up.':'Your saved boundary. No scouting area is mapped in this result. North is up.'));
    figure.append(node('p','Local boundary diagram—not a satellite photo or a geographic basemap. No extra map provider is contacted.','fi-note'));return figure;
  }
  function draftScout(field,result,sourceKey='sentinel'){
    if(!owner()||owner()!==cacheOwner||!selected()||signature(selected())!==signature(field)||!(sourceKey==='landsat'?field.landsatConsent:field.satelliteConsent))return;
    if(result.validUntil&&Date.parse(result.validUntil)<=Date.now()){get('fieldIntelligenceStatus').textContent='Refresh satellite history before preparing a task from this expired comparison.';return;}
    showModal();get('newTaskField').value=field.id;get('newTaskPlace').value=field.name;
    get('newTaskName').value=`Scout ${field.name}: check the satellite change${result.change?.currentDate?` from ${date(result.change.currentDate)}`:''}`.slice(0,200);get('newTaskName').focus();
  }
  function satelliteMeasurements(field,result,sourceKey){
    const isLandsat=sourceKey==='landsat',target=node('section',undefined,'fi-sensor-results');target.dataset.sensor=sourceKey;
    const card=detailsCard(isLandsat?'NASA/USGS Landsat vegetation change':'Sentinel-2 vegetation change',result,isLandsat?'nasa-landsat':'satellite');
    if(isLandsat)card.append(node('p','NASA/USGS Landsat 8 and 9 Collection 2 Level-2 uses 30 m surface-reflectance measurements, delivered by Microsoft Planetary Computer. It is a separate observation series: it does not replace or get compared directly with Sentinel-2 measurements.','fi-note'));
    const acquisitionYears=[...new Set(list(result.history,60).map(item=>Date.parse(item.date)).filter(value=>Number.isFinite(value)&&value<=Date.now()).map(value=>new Date(value).getUTCFullYear()))].sort((a,b)=>a-b);
    if(acquisitionYears.length&&!isLandsat)card.append(node('p',label(result.source?.attribution,`Contains modified Copernicus Sentinel data ${acquisitionYears.join(', ')}`),'fi-source fi-sentinel-credit'));
    if(acquisitionYears.length&&isLandsat)card.append(node('p',label(result.source?.attribution,'NASA/USGS Landsat 8/9 Collection 2 Level-2 · Microsoft Planetary Computer delivery'),'fi-source fi-nasa-credit'));
    const changes=result.change||{};card.append(node('h4',({detected:'A change is worth scouting',stable:'No material change in this comparison',insufficient:'Not enough comparable clear measurements'})[changes.status]||'Comparison unavailable'));
    if(changes.message)card.append(node('p',label(changes.message)));
    const facts=node('dl',undefined,'fi-facts');pair(facts,'Previous / current acquisition',`${date(changes.previousDate)} / ${date(changes.currentDate)}`);pair(facts,'NDVI change (index points)',number(changes.ndviDelta,'',3));pair(facts,'Relative NDVI change',number(changes.ndviPercent,'%'));pair(facts,'Confidence',label(changes.confidence));pair(facts,'Comparable pixels',number(changes.matchedPixels,'',0));
    if(finite(result.resolutionMeters))pair(facts,'Analysis grid',number(result.resolutionMeters,' m',0));
    if(finite(changes.matchedPercent))pair(facts,'Comparable clear field coverage',number(changes.matchedPercent,'%'));
    if(finite(changes.affectedAreaAcres))pair(facts,'Flagged pixel area (approx.)',number(changes.affectedAreaAcres,' acres'));
    const mappedAreas=list(result.problemAreas,128).map(item=>item.properties?.areaAcres).filter(finite);if(mappedAreas.length)pair(facts,'Mapped scouting area (approx.)',number(mappedAreas.reduce((sum,value)=>sum+value,0),' acres'));card.append(facts);
    if(changes.overlayTruncated)card.append(node('p','The diagram shows only a limited set of flagged patches. The total flagged pixel area can be larger than the drawn area.','fi-note'));
    card.append(node('p','A vegetation signal change is not proof of disease, water stress, yield loss or a need to spray. Confirm crop stage and field conditions by scouting.','fi-note'));
    if(changes.status==='detected'&&(!result.validUntil||Date.parse(result.validUntil)>Date.now()))card.append(button('Review a scouting task',()=>draftScout(field,result,sourceKey),'primary'));
    target.append(card);const diagram=boundaryView(field,result.problemAreas,sourceKey);if(diagram)target.append(diagram);
    const history=node('section',undefined,'fi-history');history.append(node('h3',isLandsat?'NASA Landsat history':'Sentinel-2 history'),node('p',isLandsat?'NDVI describes red/near-infrared vegetation reflectance. NDRE is unavailable because Landsat does not have the required red-edge band. These are dated measurements, not a live photo or crop-health diagnosis.':'NDVI describes red/near-infrared vegetation reflectance; NDRE uses the red-edge band. Both are unitless indices, not crop-health diagnoses. Compare dates, crop stage and clear-pixel coverage together.','fi-note'));
    const records=list(result.history,60).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    if(records[0]?.date&&Date.now()-Date.parse(records[0].date)>14*86400000)history.append(node('p','The latest returned acquisition is older than two weeks. It does not describe today’s field conditions.','fi-warning'));
    if(!records.length)history.append(node('p','No usable history returned. Nothing has been estimated.','fi-empty'));
    for(const item of records){const row=node('article',undefined,'fi-history-row');row.append(node('h4',date(item.date)));const dl=node('dl',undefined,'fi-facts');if(item.sourceName)pair(dl,'Source',label(item.sourceName));if(item.platform)pair(dl,'Satellite',label(item.platform));pair(dl,'NDVI',number(item.ndvi,'',3));pair(dl,'NDRE',isLandsat?'Unavailable — no red-edge band':number(item.ndre,'',3));pair(dl,'10th–90th percentile NDVI',finite(item.p10)&&finite(item.p90)?`${number(item.p10,'',3)}–${number(item.p90,'',3)}`:'Not reported');pair(dl,'Clear pixels',number(item.clearPercent,'%'));pair(dl,'Field coverage',number(item.coveragePercent,'%'));pair(dl,'Field cloud/shadow pixels',number(item.cloudPercent,'%'));pair(dl,'Usable pixels',number(item.validPixels,'',0));pair(dl,'Quality',label(item.status));pair(dl,'Confidence',label(item.confidence));row.append(dl);
      const source=sourceLink({name:'Open source scene record',url:item.sourceUrl});if(source)row.append(source);if(item.sourceId)row.append(node('p',`Scene: ${label(item.sourceId)}`,'fi-source-id'));history.append(row);
    }target.append(history);
    return target;
  }
  function satelliteCard(field,entry){
    const target=get('fieldSatelliteResults');target.replaceChildren();
    if(!field.boundary){target.append(node('p','Draw or import this field’s boundary in My fields before checking satellite history. A point cannot describe within-field vegetation.','fi-empty'),button('Edit field boundary',()=>{openPage('fields');window.FarmerWorkspace?.openField?.(field.id);window.FarmerFieldMap?.select(field.id);}));return;}
    if(!field.satelliteConsent&&!field.landsatConsent){target.append(node('p','Satellite and historical crop data are off for this field. Review the separate boundary-sharing permissions above.','fi-empty'));const diagram=boundaryView(field,[]);if(diagram)target.append(diagram);return;}
    if(!entry?.data){target.append(node('p',entry?.error||'Choose Check satellite history. Clear images may be days apart; cloudy, tiny or incompletely covered fields can have no usable measurements.','fi-empty'));return;}
    const result=entry.data;
    if(field.satelliteConsent&&field.landsatConsent)target.append(node('p','Two independent sources: Sentinel-2 and NASA/USGS Landsat. Their dates, resolution and clear coverage differ. Changes are compared within each source, never across sensors; the same area can appear in both and should not be counted twice.','fi-note'));
    if(field.satelliteConsent)target.append(satelliteMeasurements(field,result,'sentinel'));
    if(field.landsatConsent)target.append(satelliteMeasurements(field,result.landsat||{status:'unavailable',source:{name:'NASA/USGS Landsat 8/9',url:'https://www.usgs.gov/landsat-missions'},message:'NASA/USGS Landsat returned no result. Check again later; no measurements have been estimated.',resolutionMeters:30},'landsat'));
    if(!field.satelliteConsent)return;
    const crops=node('section',undefined,'fi-crop-history');crops.append(node('h3','Historical crop classification'),node('p','USDA Cropland Data Layer is annual land-cover context at a representative point—not real-time crop health, a field-wide crop census or confirmation of what you grow now.','fi-note'));
    const cropRecords=list(result.cropHistory,12);if(!cropRecords.length)crops.append(node('p',result.cropHistoryStatus==='unavailable'?'Historical crop classification is unavailable. Your entered crop is unchanged.':'No historical crop classification was returned.','fi-empty'));
    for(const item of cropRecords){const row=node('div',undefined,'fi-crop-row');row.append(node('b',`${label(item.year)} · ${label(item.label)}`),node('span',`${number(item.resolutionMeters,' m',0)} source layer · representative point`));const source=sourceLink({name:'USDA source',url:item.sourceUrl});if(source)row.append(source);crops.append(row);}target.append(crops);
  }

  function selectedEntries(field){if(!owner()||owner()!==cacheOwner)return{};const entry=cache.get(field.id);return entry?.signature===signature(field)?entry:{};}
  function renderResults(){
    const field=selected();if(!field||!owner())return;const entry=selectedEntries(field);
    contextCards(field,entry.context);satelliteCard(field,entry.satellite);
    get('refreshFarmContext').disabled=saving||!field.location||!field.contextConsent||requests.has(`context:${field.id}`);
    get('refreshFieldSatellite').disabled=saving||!field.boundary||(!field.satelliteConsent&&!field.landsatConsent)||requests.has(`satellite:${field.id}`);
    get('refreshFarmContext').textContent=requests.has(`context:${field.id}`)?'Loading farm context…':'Refresh farm context';
    get('refreshFieldSatellite').textContent=requests.has(`satellite:${field.id}`)?'Checking satellite history…':'Check satellite history';
  }
  async function refresh(kind){
    const field=selected(),expected=owner();if(!expected||expected!==cacheOwner||!field)return;
    if(kind==='context'?!field.contextConsent||!field.location:(!field.satelliteConsent&&!field.landsatConsent)||!field.boundary)return;
    const requestKey=`${kind}:${field.id}`;if(requests.has(requestKey))return;
    const token=generation,original=signature(field),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);controller.fieldSignature=original;requests.set(requestKey,controller);renderResults();
    get('fieldIntelligenceStatus').textContent=kind==='satellite'?'Checking dated satellite scenes and clear-pixel coverage. This may take a minute.':'Checking the selected field’s sources…';
    const stillValid=()=>owner()===expected&&token===generation&&allFields().some(item=>item.id===field.id&&signature(item)===original);
    try{
      const endpoint=kind==='context'?'farm-context':'field-satellite';
      const response=await fetch(`/api/${endpoint}?fieldId=${encodeURIComponent(field.id)}&refresh=1`,{credentials:'same-origin',cache:'no-store',headers:{'X-Farmer-Account-ID':expected},signal:controller.signal});
      if(!response.ok)throw new Error(response.status===401||response.status===403?'Reconnect your account before checking field data.':`The ${kind==='context'?'farm context':'satellite'} service is unavailable (${response.status}). Try again later.`);
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('The field service returned an unexpected response. Refresh the app and retry.');
      const result=await response.json();if(!stillValid())return;
      if(result?.fieldId!==field.id||result?.locationKey!==window.FarmerFieldGeometry?.locationKey(field))throw new Error('The response does not match this field’s saved location. Save the field and retry.');
      const entry=selectedEntries(field);cache.set(field.id,{...entry,signature:original,[kind]:{data:result}});
      if(selectedId===field.id)get('fieldIntelligenceStatus').textContent='Check each source’s status and dates below. Unavailable data has not been filled in.';
    }catch(error){
      if(!stillValid())return;const message=error.name==='AbortError'?'The request took too long. Please retry; your field records are unchanged.':error.message;
      cache.set(field.id,{...selectedEntries(field),signature:original,[kind]:{error:message}});if(selectedId===field.id)get('fieldIntelligenceStatus').textContent=message;
    }finally{clearTimeout(timer);if(requests.get(requestKey)===controller)requests.delete(requestKey);if(stillValid())renderResults();}
  }
  async function savePreferences(event){
    event.preventDefault();const field=selected(),expected=owner();if(saving||!expected||expected!==cacheOwner||!field)return;
    const report=get('contextMarketReport').value.trim(),marketLabel=get('contextMarketLabel').value.trim();
    if(report&&!/^\d{1,8}$/.test(report)){get('fieldIntelligenceStatus').textContent='Use a USDA report number of 1 to 8 digits, or leave it blank.';get('contextMarketReport').focus();return;}
    if(!window.FarmerWorkspace?.updateFieldContext){get('fieldIntelligenceStatus').textContent='Refresh the app to load the field settings editor.';return;}
    const patch={contextConsent:get('contextPermission').checked,satelliteConsent:get('satellitePermission').checked,landsatConsent:get('landsatPermission').checked,marketReportId:report,marketLabel};
    saving=true;get('saveFieldIntelligence').disabled=true;renderResults();
    try{const result=await window.FarmerWorkspace.updateFieldContext(field.id,patch);if(owner()!==expected)return;viewSignature='';render();get('fieldIntelligenceStatus').textContent=result?.synced===false?'Saved on this device, but cloud sync has not completed. Retry sync before refreshing sources.':'Permissions saved. Choose Refresh farm context or Check satellite history when you’re ready.';}
    catch(error){if(owner()===expected)get('fieldIntelligenceStatus').textContent=error.message||'Could not save these preferences. Please retry.';}
    finally{saving=false;if(owner()===expected){get('saveFieldIntelligence').disabled=false;renderResults();}}
  }
  function checkbox(id,title,description){const label=node('label',undefined,'fi-permission');const input=node('input');input.type='checkbox';input.id=id;const copy=node('span');copy.append(node('b',title),node('span',description,'fi-note'));label.append(input,copy);return label;}
  function mount(){
    const page=get('intelligencePage');if(mounted||!page)return;mounted=true;
    const panel=node('section',undefined,'field-intelligence');panel.id='fieldIntelligence';panel.setAttribute('aria-labelledby','fieldIntelligenceHeading');const heading=node('h2','Understand your field');heading.id='fieldIntelligenceHeading';
    panel.append(heading,node('p','Phase 2 · farm context. Phase 3 · satellite change. Available on Free. Choose a saved field, decide what to share, then check its sources.','fi-intro'));
    const label=node('label','Saved field','fi-select-label'),select=node('select');select.id='intelligenceField';select.onchange=()=>{selectedId=select.value;viewSignature='';render();};label.append(select);panel.append(label);
    const empty=node('p','','fi-empty');empty.id='fieldIntelligenceEmpty';panel.append(empty);
    const content=node('div');content.id='fieldIntelligenceContent';
    const details=node('details',undefined,'fi-permissions');details.id='fieldDataPermissions';details.append(node('summary','Data permissions and market report'));
    const form=node('form');form.id='fieldIntelligenceForm';form.onsubmit=savePreferences;
    form.append(node('p','These permissions are separate from weather and elevation. Opening this page sends nothing to a new provider. Farmer names, email, notes and tasks are not sent.','fi-note'));
    form.append(checkbox('contextPermission','Connect farm context','Allow this field’s representative location and crop to be queried with USDA soil/statistics, AirNow and Washington Ecology. USDA Market News receives only your selected report number.'));
    form.append(checkbox('satellitePermission','Connect satellite and crop history','Allow this field’s boundary or bounding coordinates to be used with Sentinel-2 public imagery providers and its representative point with USDA crop-history data.'));
    form.append(checkbox('landsatPermission','Connect NASA/USGS Landsat','Allow this field’s bounding coordinates to be queried with Microsoft Planetary Computer, which delivers NASA/USGS Landsat 8/9 public imagery. Analysis uses your saved boundary on our server. This separate 30 m source adds dated NDVI measurements; it has no red-edge NDRE.'));
    const market=node('label','USDA Market News report number (optional)'),input=node('input');input.id='contextMarketReport';input.inputMode='numeric';input.pattern='[0-9]{1,8}';input.maxLength=8;market.append(input);
    const marketName=node('label','Your report label (optional)'),name=node('input');name.id='contextMarketLabel';name.maxLength=120;name.placeholder='e.g. My selected apple report';marketName.append(name);
    form.append(market,marketName);const directory=sourceLink({name:'Find a report in USDA Market News',url:'https://mymarketnews.ams.usda.gov/'});if(directory)form.append(directory);
    form.append(node('p','Provider keys, if needed, are configured by the app administrator—not by farmers. Turning a permission off stops new queries and hides its results. Save changes before refreshing.','fi-note'));
    const save=button('Save data preferences',()=>{} ,'primary');save.type='submit';save.onclick=null;save.id='saveFieldIntelligence';form.append(save);details.append(form);content.append(details);
    const status=node('p','','fi-status');status.id='fieldIntelligenceStatus';status.setAttribute('role','status');content.append(status);
    const section=node('section',undefined,'fi-context-section');section.append(node('h2','Farm context'));const refreshContext=button('Refresh farm context',()=>refresh('context'));refreshContext.id='refreshFarmContext';section.append(refreshContext);const cards=node('div',undefined,'fi-card-grid');cards.id='fieldContextCards';section.append(cards);content.append(section);
    const satellite=node('section',undefined,'fi-satellite-section');satellite.append(node('h2','Field changes from satellite'));const refreshSatellite=button('Check satellite history',()=>refresh('satellite'));refreshSatellite.id='refreshFieldSatellite';satellite.append(refreshSatellite);const results=node('div');results.id='fieldSatelliteResults';satellite.append(results);content.append(satellite);panel.append(content);
    const title=page.querySelector('.placeholder-head');if(title)title.after(panel);else if(get('farmDataStatus'))get('farmDataStatus').before(panel);else page.append(panel);
    if(get('fieldGrid')){const shortcut=node('section',undefined,'fi-shortcut');shortcut.id='fieldIntelligenceShortcut';shortcut.append(node('h2','What does outside data tell us?'),node('p','Check soil and regional context, view satellite history, and review a scouting task. You choose which field data may be shared.'),button('Open field intelligence',()=>{openPage('intelligence');render();get('fieldIntelligence').scrollIntoView({block:'start'});}));get('fieldGrid').after(shortcut);}
  }
  function clear(){generation++;for(const controller of requests.values())controller.abort();requests.clear();cache.clear();cacheOwner=null;selectedId='';viewSignature='';saving=false;for(const id of ['fieldContextCards','fieldSatelliteResults'])get(id)?.replaceChildren();if(get('fieldIntelligenceContent'))get('fieldIntelligenceContent').hidden=true;if(get('intelligenceField'))get('intelligenceField').replaceChildren();if(get('fieldIntelligenceStatus'))get('fieldIntelligenceStatus').textContent='';}
  function render(){
    mount();if(!mounted)return;const expected=owner();if(expected!==cacheOwner){clear();cacheOwner=expected;}if(!expected){get('fieldIntelligenceEmpty').hidden=false;get('fieldIntelligenceEmpty').textContent='Sign in to your private account to view saved fields.';return;}
    const fields=allFields();for(const [id,entry]of cache){const field=fields.find(item=>item.id===id);if(!field||signature(field)!==entry.signature)cache.delete(id);}
    for(const [key,controller]of requests){const id=key.slice(key.indexOf(':')+1);if(!fields.some(field=>field.id===id&&signature(field)===controller.fieldSignature)){controller.abort();requests.delete(key);}}
    if(!fields.some(field=>field.id===selectedId))selectedId=fields[0]?.id||'';
    const fingerprint=JSON.stringify(fields.map(field=>[field.id,field.name,signature(field)]))+selectedId;
    if(viewSignature!==fingerprint){viewSignature=fingerprint;const select=get('intelligenceField');select.replaceChildren();for(const field of fields){const option=node('option',field.name);option.value=field.id;select.append(option);}select.value=selectedId;select.disabled=!fields.length;
      get('fieldIntelligenceEmpty').textContent=fields.length?'':'Add and save a field in My fields first. No sample measurements or imaginary fields are shown.';get('fieldIntelligenceEmpty').hidden=!!fields.length;get('fieldIntelligenceContent').hidden=!fields.length;
      const field=selected();if(field){get('contextPermission').checked=field.contextConsent===true;get('contextPermission').disabled=!field.location&&field.contextConsent!==true;get('satellitePermission').checked=field.satelliteConsent===true;get('satellitePermission').disabled=!field.boundary&&field.satelliteConsent!==true;get('landsatPermission').checked=field.landsatConsent===true;get('landsatPermission').disabled=!field.boundary&&field.landsatConsent!==true;get('contextMarketReport').value=field.marketReportId||'';get('contextMarketLabel').value=field.marketLabel||'';get('fieldDataPermissions').open=!field.contextConsent&&!field.satelliteConsent&&!field.landsatConsent;get('fieldIntelligenceStatus').textContent=field.location?'':'Edit this field to add a location before connecting outside data.';}
    }renderResults();
  }
  function boot(){render();}
  function select(fieldId){if(!allFields().some(field=>field.id===fieldId))return;selectedId=fieldId;viewSignature='';openPage('intelligence');render();get('fieldIntelligence')?.scrollIntoView({block:'start'});}
  function contextForBrief(){if(!owner()||owner()!==cacheOwner)return[];return allFields().flatMap(field=>{const entry=selectedEntries(field);return field.contextConsent&&entry.context?.data?[entry.context.data]:[];});}
  window.FarmerIntelligence={boot,render,clear,select,contextForBrief};
  window.addEventListener('storage',event=>{if(['farmerDailyCloudOwner','farmerDailyFields'].includes(event.key))render();});
  window.addEventListener('focus',render);
  boot();
})();
