'use strict';

// Field geometry is private. The optional basemap requests only map tiles; data
// tools receive a representative coordinate only after explicit field consent.
(() => {
  const get = id => document.getElementById(id);
  const node = (tag, text, className) => { const result=document.createElement(tag);if(text!==undefined)result.textContent=String(text);if(className)result.className=className;return result; };
  const action = (text, callback, className='secondary') => {const result=node('button',text,className);result.type='button';result.onclick=callback;return result;};
  const fields = () => {try{const value=JSON.parse(localStorage.getItem('farmerDailyFields')||'[]');return Array.isArray(value)?value:[];}catch{return [];}};
  const owner = () => typeof membershipAllowsCore==='function'&&membershipAllowsCore()&&cloudEnabled&&localStorage.getItem('farmerDailyCloudOwner')===membership?.user?.id?membership.user.id:null;
  const geometry = () => window.FarmerFieldGeometry;
  const time = value => Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unavailable';
  let overviewMap=null,editorMap=null,overviewLayer=null,editorLayer=null,selectedId='',editing=null,draftBoundary=null,vertices=[],mode='point',generation=0,tilesEnabled=false,cacheOwner=null,editorNeedsInitialView=true;
  const cache=new Map(),tileLayers=new Map(),mapViews=new Map(),tileStates=new Map(),gridChoices=new Set();
  const finite = value => typeof value==='number'&&Number.isFinite(value);

  function input(labelText,id,type='text',maxLength) {
    const label=node('label',labelText),control=node('input');control.id=id;control.type=type;if(maxLength)control.maxLength=maxLength;label.append(control);return {label,control};
  }
  function mapContainer(id,label) {const container=node('div',undefined,'field-map');container.id=id;container.setAttribute('role','region');container.setAttribute('aria-label',label);return container;}
  const visible=container=>!!container&&container.getBoundingClientRect().width>0&&container.getBoundingClientRect().height>0;
  function mapFrame(kind,label){
    const name=kind==='editor'?'Editor':'Overview',frame=node('div',undefined,'field-map-frame');frame.append(mapContainer(`field${name}Map`,label));
    const consent=node('div',undefined,'field-map-consent');consent.id=`field${name}MapConsent`;
    const load=action('Load map',enableTiles,'primary field-basemap');
    const grid=action('Use coordinates instead',()=>{gridChoices.add(kind);updateMapState(kind);if(kind==='editor'){get('fieldCoordinateDetails').open=true;get('fieldLatitude').focus();}},'text-btn');
    consent.append(node('h4','Find your field on the map'),node('p','Load roads and place names, then zoom in and draw your field. OpenStreetMap receives the area you view and your browser IP—not your field names, crops or saved boundary.'),load,grid);frame.append(consent);
    const status=node('p','','field-map-status');status.id=`field${name}MapStatus`;status.setAttribute('role','status');
    const retry=action('Retry map',()=>retryTiles(kind),'secondary');retry.id=`fieldMapRetry${name}`;retry.hidden=true;
    const loadGrid=action('Load map',enableTiles,'text-btn field-basemap');loadGrid.hidden=true;
    const row=node('div',undefined,'field-map-status-row');row.append(status,retry,loadGrid);
    mapViews.set(kind,{frame,consent,status,retry,load,loadGrid});updateMapState(kind);return {frame,row};
  }
  function updateMapState(kind){
    const view=mapViews.get(kind);if(!view)return;const map=kind==='editor'?editorMap:overviewMap,state=map&&tileStates.get(map);
    const libraryMissing=!window.L,phase=libraryMissing?'unavailable':!tilesEnabled?'private':state?.phase||'loading';
    view.frame.dataset.basemap=phase;view.status.dataset.state=phase;view.consent.hidden=libraryMissing||tilesEnabled||gridChoices.has(kind);
    view.load.disabled=tilesEnabled;view.loadGrid.hidden=tilesEnabled||!gridChoices.has(kind)||libraryMissing;
    view.retry.hidden=!['error','partial','unavailable'].includes(phase);view.retry.textContent=libraryMissing?'Reload map editor':'Retry map';
    view.status.textContent=({private:gridChoices.has(kind)?'Coordinate-only view. No geographic basemap is loaded.':'Choose Load map to see roads and places. Nothing is shared until you choose it.',loading:'Loading map tiles…',ready:'Map loaded · OpenStreetMap. Zoom in to find your field.',partial:'Some map tiles could not load. Retry; your boundary is still here.',error:'Map tiles could not load. Check your connection and retry. Your boundary is still here; coordinates and GeoJSON also work.',unavailable:'The map editor did not load. Reload this page, or enter coordinates below.'})[phase];
  }
  function watchTiles(map,layer){
    const kind=map===editorMap?'editor':'overview',state={phase:'loading',loaded:0,failed:0,timer:null};tileStates.set(map,state);
    const current=()=>tileLayers.get(map)===layer;
    const start=()=>{if(!current())return;clearTimeout(state.timer);state.phase='loading';state.loaded=0;state.failed=0;updateMapState(kind);state.timer=setTimeout(()=>{if(!current())return;state.phase=state.loaded?'partial':'error';updateMapState(kind);},12000);};
    layer.on('loading',start);
    layer.on('tileload',()=>{if(current())state.loaded++;});
    layer.on('tileerror',()=>{if(current())state.failed++;});
    layer.on('load',()=>{if(!current())return;clearTimeout(state.timer);state.phase=state.failed?(state.loaded?'partial':'error'):(state.loaded?'ready':'error');updateMapState(kind);});
    start();
  }
  function removeTiles(map){const layer=tileLayers.get(map);clearTimeout(tileStates.get(map)?.timer);tileLayers.delete(map);tileStates.delete(map);if(layer)map.removeLayer(layer);}
  function notice(message){get('fieldMapMessage').textContent=message;}
  function pointFromInputs(){const lat=get('fieldLatitude').value.trim(),lon=get('fieldLongitude').value.trim();if(!lat&&!lon)return null;if(!lat||!lon)throw new Error('Enter both latitude and longitude.');return {latitude:Number(lat),longitude:Number(lon)};}
  function putPoint(location){get('fieldLatitude').value=location?.latitude??'';get('fieldLongitude').value=location?.longitude??'';}
  function normalized(value){if(!geometry())throw new Error('The field location editor is unavailable. Refresh the app.');return geometry().normalizeGeometry(value);}
  function point(field){if(finite(field?.location?.latitude)&&finite(field?.location?.longitude))return [field.location.latitude,field.location.longitude];return null;}
  function signature(field){try{return geometry().locationKey(field);}catch{return null;}}
  function center(){const place=typeof profile!=='undefined'&&profile?.locationId&&typeof waLocations!=='undefined'?waLocations[profile.locationId]:null;return place&&finite(place[1])&&finite(place[2])?[place[1],place[2]]:[47.6,-120.8];}
  function addTiles(map){if(!map||tileLayers.has(map)||!tilesEnabled||!visible(map.getContainer()))return;const layer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,keepBuffer:0,updateWhenIdle:true,referrerPolicy:'strict-origin-when-cross-origin',attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'});tileLayers.set(map,layer);watchTiles(map,layer);layer.addTo(map);}
  function retryTiles(kind){if(!window.L){location.reload();return;}const map=kind==='editor'?editorMap:overviewMap;if(map){removeTiles(map);addTiles(map);}else ensureMap(kind);updateMapState(kind);}
  function ensureMap(kind){
    const container=get(kind==='editor'?'fieldEditorMap':'fieldOverviewMap');
    if(!window.L){updateMapState(kind);return null;}if(!visible(container))return null;
    const existing=kind==='editor'?editorMap:overviewMap;if(existing){existing.invalidateSize({pan:false});return existing;}
    const map=L.map(container,{zoomControl:true,attributionControl:true,scrollWheelZoom:false}).setView(center(),13);
    const coordinateControl=L.control({position:'bottomleft'});let coordinateLabel;coordinateControl.onAdd=()=>{coordinateLabel=node('div','','field-map-coordinate-label');return coordinateLabel;};coordinateControl.addTo(map);const showCenter=()=>{const value=map.getCenter();coordinateLabel.textContent=`Center ${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`;};map.on('moveend',showCenter);showCenter();
    const layer=L.featureGroup().addTo(map);
    if(kind==='editor'){editorMap=map;editorLayer=layer;map.on('click',event=>{
      if(mode==='navigate')return;
      try{if(mode==='polygon'){if(vertices.length>=200)throw new Error('Boundaries can have at most 200 corners.');vertices.push([Number(event.latlng.lng.toFixed(6)),Number(event.latlng.lat.toFixed(6))]);draftBoundary=null;drawEditor();notice(`${vertices.length} boundary corners. Choose Finish boundary when ready.`);}
        else{const value=normalized({location:{latitude:event.latlng.lat,longitude:event.latlng.lng}});putPoint(value.location);draftBoundary=null;vertices=[];drawEditor();notice('Field point selected. Save field to keep this location.');}}
      catch(error){notice(error.message);}
    });}else{overviewMap=map;overviewLayer=layer;}
    if(window.ResizeObserver)new ResizeObserver(()=>{if(visible(container))map.invalidateSize({pan:false});}).observe(container);
    updateMapState(kind);
    return map;
  }
  function marker(mapLayer,coordinate,title,callback){const icon=L.divIcon({className:'field-point',html:'',iconSize:[18,18],iconAnchor:[9,9]});const mark=L.marker(coordinate,{icon,title,keyboard:true}).addTo(mapLayer);if(callback)mark.on('click',callback);return mark;}
  function drawField(layer,field,callback){
    if(field.boundary?.type==='Polygon'){try{const shape=L.geoJSON(field.boundary,{style:{color:'#245344',weight:3,fillColor:'#bad878',fillOpacity:.28}}).addTo(layer);if(callback)shape.on('click',callback);}catch{}}
    const coordinate=point(field);if(coordinate)marker(layer,coordinate,field.name||'Field location',callback);
  }
  function drawEditor(fit=false){
    window.dispatchEvent(new CustomEvent('field-draft-changed'));
    const map=ensureMap('editor');if(!map)return;editorLayer.clearLayers();
    let location=null;try{location=pointFromInputs();}catch{}
    if(draftBoundary)drawField(editorLayer,{location,boundary:draftBoundary});
    else if(vertices.length){L.polyline(vertices.map(([lon,lat])=>[lat,lon]),{color:'#245344',weight:3,dashArray:'6 5'}).addTo(editorLayer);for(const [lon,lat] of vertices)marker(editorLayer,[lat,lon],'Boundary corner');}
    else if(location&&finite(location.latitude)&&finite(location.longitude)&&Math.abs(location.latitude)<=90&&Math.abs(location.longitude)<=180)marker(editorLayer,[location.latitude,location.longitude],'Field location');
    if(fit&&editorLayer.getLayers().length)map.fitBounds(editorLayer.getBounds(),{padding:[24,24],maxZoom:17});
    map.getContainer().dataset.mode=mode;map.doubleClickZoom[mode==='polygon'?'disable':'enable']();
    get('fieldNavigationMode').setAttribute('aria-pressed',String(mode==='navigate'));get('fieldPointMode').setAttribute('aria-pressed',String(mode==='point'));get('fieldPolygonMode').setAttribute('aria-pressed',String(mode==='polygon'));
    get('fieldFinishBoundary').disabled=vertices.length<3;get('fieldUndoCorner').disabled=!vertices.length;
    get('fieldBoundarySummary').textContent=draftBoundary?`Boundary saved in this draft · ${draftBoundary.coordinates[0].length-1} corners. ${areaLabel(draftBoundary)}`:vertices.length?`Drawing ${vertices.length} corners; finish before saving.`:location?'Point location; no boundary recorded.':'No location yet. Select a point, draw, or enter coordinates.';
    addTiles(map);
  }
  function areaLabel(boundary){try{const acres=geometry().areaAcres(boundary);return finite(acres)?`Approximate boundary area: ${acres.toLocaleString(undefined,{maximumFractionDigits:2})} acres (not a legal survey).`:'';}catch{return '';}}
  function setMode(value){if(value===mode)return;const resuming=value==='polygon'&&vertices.length&&!draftBoundary;if(value!=='navigate'&&!resuming&&(draftBoundary||vertices.length)&&!confirm('Replace the current boundary drawing? Your saved field stays unchanged until you choose Save field.'))return;mode=value;if(value!=='navigate'&&!resuming){vertices=[];draftBoundary=null;}drawEditor();notice(value==='navigate'?'Move and zoom the map. Clicking does not change your field.':value==='point'?'Click the map to select a field point, or enter coordinates below.':'Click or tap each boundary corner in order, then choose Finish boundary and Save field. Drag to move the map.');}
  function finishBoundary(){try{if(vertices.length<3)throw new Error('Choose at least three boundary corners.');const value=normalized({boundary:{type:'Polygon',coordinates:[[...vertices,vertices[0]]]}});draftBoundary=value.boundary;vertices=[];putPoint(value.location);mode='navigate';drawEditor(true);notice('Boundary ready — not saved yet. Review your field, then choose Save field. Moving the map will not change the boundary.');}catch(error){notice(error.message);}}
  function importGeometry(){try{const text=get('fieldGeoJSON').value;if(new TextEncoder().encode(text).length>200*1024)throw new Error('Choose GeoJSON under 200 KB.');let source=JSON.parse(text);if(source?.type==='FeatureCollection'){if(source.features?.length!==1)throw new Error('Import one field at a time: choose a single Polygon feature.');source=source.features[0];}if(source?.type==='Feature')source=source.geometry;
      let value;if(source?.type==='Point'&&Array.isArray(source.coordinates)&&source.coordinates.length===2)value=normalized({location:{longitude:source.coordinates[0],latitude:source.coordinates[1]}});else value=normalized({boundary:source});
      draftBoundary=value.boundary||null;vertices=[];putPoint(value.location);mode=draftBoundary?'navigate':'point';drawEditor(true);notice('Geometry imported locally. Nothing is sent until you save the field.');
    }catch(error){notice(error instanceof SyntaxError?'That is not valid GeoJSON. Paste one Polygon or Point geometry.':error.message);}}
  function enableTiles(){currentCache();if(!owner())return;tilesEnabled=true;if(get('fieldDialog')?.open){drawEditor();addTiles(editorMap);}else{render();addTiles(overviewMap);}for(const kind of mapViews.keys())updateMapState(kind);}

  function install(){
    const form=get('fieldForm');if(!form||get('fieldLocationEditor'))return;
    const wrapper=node('section',undefined,'field-location-editor');wrapper.id='fieldLocationEditor';wrapper.append(node('h3','Draw your field on the map'));
    form.insertBefore(wrapper,get('fieldCrop')?.closest('label')?.nextSibling||get('fieldError'));
    wrapper.append(node('p','1. Load the map and find your field. 2. Choose Draw boundary and tap each corner. 3. Finish boundary, then Save field. A single point works too.','workspace-note'));
    const jump=node('div',undefined,'field-map-jump'),community=node('select');community.id='fieldMapCommunity';community.setAttribute('aria-label','Go to a Washington community');
    for(const [id,place] of Object.entries(typeof waLocations!=='undefined'?waLocations:{})){const option=node('option',place[0]);option.value=id;community.append(option);}
    community.onchange=()=>{const place=typeof waLocations!=='undefined'?waLocations[community.value]:null;if(place){const map=ensureMap('editor');map?.setView([place[1],place[2]],13);notice('Map moved to the selected community. Your saved field location has not changed.');}};
    const recenter=action('Zoom to field',()=>{const map=ensureMap('editor');if(!map)return;if(editorLayer.getLayers().length)map.fitBounds(editorLayer.getBounds(),{padding:[24,24],maxZoom:17});else map.setView(center(),13);});recenter.id='fieldMapCenter';jump.append(community,recenter);wrapper.append(jump);
    const toolbar=node('div',undefined,'field-map-toolbar'),navigateButton=action('Move map',()=>setMode('navigate')),pointButton=action('Select point',()=>setMode('point')),polygonButton=action('Draw boundary',()=>setMode('polygon'));navigateButton.id='fieldNavigationMode';pointButton.id='fieldPointMode';polygonButton.id='fieldPolygonMode';
    const finish=action('Finish boundary',finishBoundary),undo=action('Undo corner',()=>{vertices.pop();drawEditor();notice(`${vertices.length} boundary corners. Continue drawing or finish the boundary.`);}),clear=action('Clear geometry',()=>{if((draftBoundary||vertices.length||get('fieldLatitude').value||get('fieldLongitude').value)&&!confirm('Clear this draft location and boundary? Your saved field stays unchanged until you save.'))return;vertices=[];draftBoundary=null;putPoint(null);mode='point';drawEditor();notice('Draft location cleared. Select a new point or draw a boundary.');});finish.id='fieldFinishBoundary';undo.id='fieldUndoCorner';clear.id='fieldClearGeometry';toolbar.append(polygonButton,finish,navigateButton,pointButton,undo,clear);
    const editor=mapFrame('editor','Field drawing map. Use Draw boundary then tap corners; coordinates below are an alternative.');wrapper.append(editor.frame,editor.row,toolbar);
    const message=node('p','','workspace-note field-drawing-help');message.id='fieldMapMessage';message.setAttribute('role','status');wrapper.append(message);
    const summary=node('p','','workspace-note');summary.id='fieldBoundarySummary';wrapper.append(summary);
    const coordinateDetails=node('details');coordinateDetails.id='fieldCoordinateDetails';coordinateDetails.append(node('summary','Enter exact coordinates instead'));
    const coordinates=node('div',undefined,'field-coordinate-row'),latitude=input('Latitude','fieldLatitude','number'),longitude=input('Longitude','fieldLongitude','number');latitude.control.step=longitude.control.step='any';latitude.control.min='45.5';latitude.control.max='49.1';longitude.control.min='-125';longitude.control.max='-116.7';
    for(const control of [latitude.control,longitude.control])control.addEventListener('change',()=>{if(draftBoundary&&!confirm('Replace the boundary with this point location? Your saved field stays unchanged until you save.')){putPoint(normalized({boundary:draftBoundary}).location);return;}draftBoundary=null;vertices=[];mode='point';drawEditor(true);notice('Coordinate edit uses a point location and clears the draft boundary.');});coordinates.append(latitude.label,longitude.label);coordinateDetails.append(coordinates,node('p','Washington fields only. Latitude first; longitude is negative. GeoJSON uses the opposite order: [longitude, latitude].','workspace-note'));wrapper.append(coordinateDetails);
    const disclosure=node('details'),disclosureTitle=node('summary','Import a boundary or point (GeoJSON)'),json=node('textarea');json.id='fieldGeoJSON';json.rows=4;json.maxLength=200*1024;json.setAttribute('aria-label','GeoJSON field geometry');json.placeholder='{"type":"Polygon","coordinates":[[[-122.2,47.6],…]]}';const file=input('Or choose a GeoJSON file (up to 200 KB)','fieldGeoJSONFile','file');file.control.accept='.geojson,.json,application/geo+json,application/json';file.control.onchange=async()=>{const chosen=file.control.files[0];if(!chosen)return;const token=generation;try{if(chosen.size>200*1024)throw new Error('Choose GeoJSON under 200 KB.');const text=await chosen.text();if(token!==generation)return;json.value=text;importGeometry();}catch(error){if(token===generation)notice(error.message);}};disclosure.append(disclosureTitle,node('p','One Polygon with a closed outer ring, up to 200 corners, no holes or crossing edges. Polygon properties are ignored. Point geometry is also supported.','workspace-note'),json,file.label,action('Use pasted GeoJSON',importGeometry));wrapper.append(disclosure);
    const consent=node('label',undefined,'field-data-consent'),checkbox=node('input');checkbox.type='checkbox';checkbox.id='fieldDataConsent';consent.append(checkbox,node('span','Allow field weather and elevation tools to share this field’s representative coordinate with NOAA/NWS, Open-Meteo (weather backup), and USGS. Names, crops, notes, and the boundary are not shared with those providers.'));wrapper.append(consent,node('p','The field profile and geometry remain in your private Farmer Daily account. You can save without external data access and enable it later.','workspace-note'));
    const metadata=node('details');metadata.id='fieldCropDetails';metadata.append(node('summary','Optional crop details and timing'));
    for(const id of ['fieldStage','fieldAcres']){const label=get(id)?.closest('label');if(label)metadata.append(label);}
    const variety=input('Variety (optional)','fieldVariety','text',80);metadata.append(variety.label);
    const dateRow=node('div',undefined,'field-coordinate-row');for(const [name,label] of [['plantingDate','Planting date (optional)'],['bloomDate','Bloom date (optional)'],['transplantDate','Transplant date (optional)']])dateRow.append(input(label,`field-${name}`,'date').label);metadata.append(dateRow);wrapper.append(metadata);
    if(get('fieldName')?.closest('label')&&get('fieldCrop')?.closest('label')){const core=node('div',undefined,'field-core-fields');form.insertBefore(core,wrapper);core.append(get('fieldName').closest('label'),get('fieldCrop').closest('label'));}
    form.addEventListener('invalid',event=>{let details=event.target.closest('details');while(details){details.open=true;details=details.parentElement.closest('details');}},true);
    const overview=node('section',undefined,'field-map-panel');overview.id='fieldMapPanel';overview.append(node('h2','Your field map'),node('p','See your saved fields here. To draw a new one, choose Add field. Select a saved field for its weather and elevation.','workspace-note'));
    const overviewView=mapFrame('overview','Your private field map');overview.append(overviewView.frame,overviewView.row);
    const detail=node('section',undefined,'field-conditions');detail.id='fieldConditions';detail.setAttribute('aria-live','polite');overview.append(detail);get('fieldGrid').before(overview);
    get('fieldDialog').addEventListener('close',close);
  }
  function open(field){install();currentCache();const token=++generation;editing=field||null;editorNeedsInitialView=true;draftBoundary=field?.boundary?structuredClone(field.boundary):null;vertices=[];mode=draftBoundary?'navigate':'point';get('fieldVariety').value=field?.variety||'';for(const name of ['plantingDate','bloomDate','transplantDate'])get(`field-${name}`).value=field?.[name]||'';get('fieldDataConsent').checked=field?.dataConsent===true;putPoint(field?.location);get('fieldGeoJSON').value='';get('fieldGeoJSONFile').value='';get('fieldCoordinateDetails').open=false;get('fieldCropDetails').open=false;get('fieldMapCommunity').value=typeof profile!=='undefined'?profile?.locationId||'':'';notice(draftBoundary?'Your saved boundary is displayed. Move or zoom the map without changing it.':'Load the map, zoom to your field, then select a point or draw its boundary.');requestAnimationFrame(()=>{if(token!==generation||!get('fieldDialog').open)return;refreshEditor();});}
  function close(){generation++;editing=null;vertices=[];draftBoundary=null;editorNeedsInitialView=true;}
  function refreshEditor(){if(!get('fieldDialog').open)return;const map=ensureMap('editor');if(!map)return;if(editorNeedsInitialView&&!editing?.location)map.setView(center(),13);drawEditor(editorNeedsInitialView);editorNeedsInitialView=false;updateMapState('editor');}
  function draftStatus(){if(vertices.length)return {kind:'drawing',corners:vertices.length};if(draftBoundary)return {kind:'boundary',corners:draftBoundary.coordinates[0].length-1};try{const location=pointFromInputs();if(location&&normalized({location}).location)return {kind:'point',corners:0};}catch{}return {kind:'none',corners:0};}
  function finishForReview(){finishBoundary();if(!draftBoundary)throw new Error(get('fieldMapMessage').textContent);}
  function readValue(){
    if(vertices.length)throw new Error('Finish or clear the boundary drawing before saving.');
    const location=pointFromInputs();if(!location&&!draftBoundary&&!editing)throw new Error('Add a field point or boundary before saving this new field.');
    const value=location||draftBoundary?normalized({...(location?{location}:{}),...(draftBoundary?{boundary:draftBoundary}:{})}):{};
    const dates=Object.fromEntries(['plantingDate','bloomDate','transplantDate'].map(name=>[name,get(`field-${name}`).value]));
    return {...value,...dates,variety:get('fieldVariety').value.trim(),dataConsent:get('fieldDataConsent').checked,...(!draftBoundary?{boundary:null}:{}),...(!location&&!draftBoundary?{location:null}: {})};
  }
  function currentCache(){const account=owner();if(account!==cacheOwner){const previous=cacheOwner;cache.clear();cacheOwner=account;selectedId='';generation++;tilesEnabled=false;gridChoices.clear();for(const map of [...tileLayers.keys()])removeTiles(map);overviewLayer?.clearLayers();editorLayer?.clearLayers();if(previous&&get('fieldDialog')?.open)get('fieldDialog').close();for(const kind of mapViews.keys())updateMapState(kind);}if(!account)return [];const current=fields();for(const [id,value] of cache){const field=current.find(item=>item.id===id);if(!field||field.dataConsent!==true||signature(field)!==value.locationKey)cache.delete(id);}return [...cache.values()];}
  function render(records=fields()){
    install();currentCache();if(!owner()){overviewLayer?.clearLayers();editorLayer?.clearLayers();get('fieldConditions').replaceChildren();get('fieldMapPanel').hidden=true;return;}get('fieldMapPanel').hidden=false;
    const map=ensureMap('overview');if(map){overviewLayer.clearLayers();for(const field of records)drawField(overviewLayer,field,()=>select(field.id));if(overviewLayer.getLayers().length)map.fitBounds(overviewLayer.getBounds(),{padding:[24,24],maxZoom:16});else map.setView(center(),13);addTiles(map);}updateMapState('overview');
    if(!records.some(field=>field.id===selectedId))selectedId=records[0]?.id||'';renderDetails();
  }
  function select(id){selectedId=id;renderDetails();get('fieldConditions').scrollIntoView({block:'nearest',behavior:'smooth'});const field=fields().find(item=>item.id===id);if(point(field)&&overviewMap)overviewMap.setView(point(field),Math.max(overviewMap.getZoom(),13));}
  function metric(label,value){const item=node('div',undefined,'field-metric');item.append(node('span',label),node('b',value));return item;}
  function safeSource(text,href){const link=node('a',text);link.href=href;link.target='_blank';link.rel='noopener noreferrer';return link;}
  function renderDetails(){
    const target=get('fieldConditions');target.replaceChildren();const field=fields().find(item=>item.id===selectedId);
    if(!field){target.append(node('p','Add your first field to connect weather and elevation.','workspace-note'));return;}
    target.append(node('h3',field.name),node('p',[field.crop,field.variety,field.stage].filter(Boolean).join(' · '),'workspace-note'));
    if(!point(field)){target.append(node('p','Add a location to this field to retrieve field-specific weather and elevation.','field-data-warning'));return;}
    target.append(node('p',`${field.location.latitude.toFixed(5)}, ${field.location.longitude.toFixed(5)} · ${field.boundary?'Boundary recorded':'Point location'}`,'workspace-note'));
    const cropDates=[['plantingDate','Planted'],['bloomDate','Bloom'],['transplantDate','Transplanted']].filter(([name])=>field[name]).map(([name,label])=>`${label}: ${field[name]}`);if(cropDates.length)target.append(node('p',cropDates.join(' · '),'workspace-note'));
    if(field.dataConsent!==true){target.append(node('p','External data is off. Edit this field to allow coordinate sharing with NWS, the Open-Meteo weather backup, and USGS.','field-data-warning'));return;}
    const item=currentCache().find(entry=>entry.fieldId===field.id),refresh=action(item?'Refresh field conditions':'Load field conditions',()=>loadFieldData(field.id,true));refresh.id='loadFieldDataBtn';target.append(refresh);
    if(!item){target.append(node('p','Not loaded. A missing response does not mean clear weather or no alerts.','workspace-note'));return;}
    if(item.loading){refresh.disabled=true;target.append(node('p','Saving private field records, then retrieving conditions…','workspace-note'));}
    if(item.error)target.append(node('p',item.error,'field-data-warning'));
    renderPayload(target,item);
  }
  function renderPayload(target,item){
    const weather=item.weather,forecast=weather?.forecast||weather?.data||weather;
    const backup=forecast?.source?.id==='open-meteo',sourceName=backup?'Open-Meteo backup':'NOAA / National Weather Service';
    const forecastAge=Date.now()-Date.parse(forecast?.fetchedAt||item.fetchedAt),hasCoverage=forecast?.hourly?.some(hour=>Date.parse(hour.startTime)<=Date.now()&&Date.parse(hour.endTime)>Date.now());
    if(forecast?.hourly?.length&&hasCoverage&&Number.isFinite(forecastAge)&&forecastAge>=-60000&&forecastAge<6*60*60000){
      const now=Date.now(),hour=forecast.hourly.find(value=>Date.parse(value.startTime)<=now&&Date.parse(value.endTime)>now)||forecast.hourly.find(value=>Date.parse(value.endTime)>now),current=forecast.current;
      const observedAt=Date.parse(current?.observedAt),live=finite(current?.temperature)&&Number.isFinite(observedAt)&&observedAt<=now+60000&&now-observedAt<90*60000;
      const metrics=node('div',undefined,'field-metrics');metrics.append(metric(live?'Nearby observation':'Current hourly forecast',finite(live?current.temperature:hour?.temperature)?`${Math.round(live?current.temperature:hour.temperature)}°F`:'Unavailable'),metric('Wind',hour?.windSpeed||'Unknown'),metric('Rain chance',finite(hour?.probabilityOfPrecipitation?.value)?`${hour.probabilityOfPrecipitation.value}%`:'Unknown'),metric('Humidity',finite(hour?.relativeHumidity?.value)?`${Math.round(hour.relativeHumidity.value)}%`:'Unknown'));target.append(metrics);
      target.append(node('p',hour?.shortForecast||'Forecast description unavailable','workspace-note'),node('p',`${live?`Observation ${time(current.observedAt)} · `:''}${sourceName} forecast retrieved ${time(forecast.fetchedAt||weather.fetchedAt||item.fetchedAt)}${forecast.cached||weather.cached||item.weatherStatus==='cached'?' · cached data':''}. A point forecast is not a measurement of every part of your field.`,'workspace-note'));
      const table=node('div',undefined,'field-hourly');table.setAttribute('role','list');for(const value of forecast.hourly.filter(period=>Date.parse(period.endTime)>now).slice(0,6)){const row=node('div',undefined,'field-hour-row');row.setAttribute('role','listitem');row.append(node('span',new Date(value.startTime).toLocaleTimeString(undefined,{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'})),node('b',finite(value.temperature)?`${Math.round(value.temperature)}°F`:'Unknown'),node('span',value.windSpeed||'Wind unknown'),node('span',finite(value.probabilityOfPrecipitation?.value)?`${value.probabilityOfPrecipitation.value}% rain`:'Rain unknown'));table.append(row);}target.append(node('p','Next six forecast hours · Pacific time','workspace-note'),table,safeSource(sourceName,backup?'https://open-meteo.com/':'https://www.weather.gov/'));if(backup)target.append(safeSource('CC BY 4.0 · units and wording adapted','https://creativecommons.org/licenses/by/4.0/'));
    }else if(!item.loading)target.append(node('p',weather?.message||weather?.error||'Field weather is currently unavailable or its saved forecast has expired. No conditions are inferred.','field-data-warning'));
    const elevation=item.elevation;
    if(elevation){const feet=finite(elevation.feet)?elevation.feet:finite(elevation.value)&&elevation.unit==='feet'?elevation.value:finite(elevation.meters)?elevation.meters*3.280839895:null;target.append(node('p',finite(feet)?`Elevation at field point: ${Math.round(feet).toLocaleString()} ft · retrieved ${time(elevation.fetchedAt)}. Terrain estimate; not a frost correction.`:elevation.message||elevation.error||'USGS elevation unavailable.','workspace-note'),safeSource('USGS 3DEP elevation','https://www.usgs.gov/3d-elevation-program'));}
    const alerts=item.alerts||weather?.alerts||forecast?.alerts;
    if(Array.isArray(alerts)||Array.isArray(alerts?.items)){
      const age=Date.now()-Date.parse(alerts?.fetchedAt),list=(Array.isArray(alerts)?alerts:alerts.items).filter(entry=>!Number.isFinite(Date.parse(entry.expires||entry.ends))||Date.parse(entry.expires||entry.ends)>Date.now());if(alerts?.status==='unavailable'||alerts?.status==='error'||!Number.isFinite(age)||age< -60000||age>2*60000)target.append(node('p','Weather alert check unavailable or expired. Refresh and check NWS directly; no-alert status is unknown.','field-data-warning'));
      else {target.append(node('h4',list.length?`${list.length} NWS weather ${list.length===1?'alert':'alerts'}`:'No active alerts returned by NWS'),node('p',`${alerts.status==='cached'?'Cached alert check':'Alert check'} · ${time(alerts.fetchedAt)}. Conditions can change; this is not a guarantee of safe conditions.`,'workspace-note'));for(const entry of list){const card=node('article',undefined,'field-alert');card.append(node('b',entry.headline||entry.event||'Weather alert'),node('p',entry.instruction||entry.description||'Read the official NWS alert for details.'),node('small',`Valid until ${time(entry.expires||entry.ends)}`));target.append(card);}}
    }else target.append(node('p','Weather alert status is unknown until a successful NWS alert check.','field-data-warning'));
    target.append(safeSource('Check official NWS alerts','https://www.weather.gov/alerts'));
  }
  async function loadFieldData(id,refresh=false){
    const expected=owner(),field=fields().find(value=>value.id===id),key=field&&signature(field);if(!expected||!key||field.dataConsent!==true)return null;
    currentCache();selectedId=id;const request=crypto.randomUUID(),previous=cache.get(id);cache.set(id,{...previous,fieldId:id,locationKey:key,request,loading:true});renderDetails();
    const valid=()=>owner()===expected&&fields().some(value=>value.id===id&&value.dataConsent===true&&signature(value)===key)&&cache.get(id)?.request===request;
    try{if(!await saveCloudState())throw new Error('Sync this field to your private account before retrieving data. Your device changes are still saved.');if(!valid())return null;const data=await memberFetch(`/api/field-data?fieldId=${encodeURIComponent(id)}${refresh?'&refresh=1':''}`);if(!valid())return null;if(data.fieldId&&data.fieldId!==id)throw new Error('The field response did not match this field. Retry after refreshing.');if(data.locationKey&&data.locationKey!==key)throw new Error('This field location changed. Refresh its data.');const value={...data,fieldId:id,locationKey:key,loading:false};cache.set(id,value);renderDetails();window.dispatchEvent(new CustomEvent('field-data-updated',{detail:{fieldId:id}}));return value;
    }catch(error){if(valid()){cache.set(id,{...previous,fieldId:id,locationKey:key,loading:false,error:error.message||'Field data could not be loaded. Please retry.'});renderDetails();window.dispatchEvent(new CustomEvent('field-data-updated',{detail:{fieldId:id}}));}return null;}
  }
  install();window.FarmerFieldMap={open,readValue,close,render,select,loadFieldData,cachedData:currentCache,refreshEditor,draftStatus,finishForReview};
  setInterval(()=>{if(!document.hidden&&get('fieldMapPanel')?.offsetParent!==null&&get('fieldMapPanel')&&!get('fieldMapPanel').hidden)renderDetails();},15000);
})();
