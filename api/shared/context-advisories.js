'use strict';
// Phase 2/3 evidence augments, but never suppresses, higher-priority official alerts.
const { locationKey, normalizeGeometry } = require('./field-geometry');
const { SOURCES, TTL } = require('./context-providers');
const DAY=86400000,HOUR=3600000,MAX_CONTEXT_FIELDS=3;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const clean=(value,fallback='',max=180)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):fallback;
const time=value=>typeof value==='string'?Date.parse(value):NaN;
const recent=(value,now,age)=>Number.isFinite(time(value))&&time(value)<=now&&now-time(value)<age;
function selectIntelligenceFields(fields=[],tasks=[],profile={},permission='contextConsent'){
  return fields.filter(field=>{
    if(permission==='satelliteConsent' ? !(field?.satelliteConsent===true||field?.landsatConsent===true)||!field.boundary : field?.[permission]!==true)return false;
    try{normalizeGeometry(field);return true;}catch{return false;}
  }).map((field,index)=>({field,index,score:(field.id===profile.priorityField||field.name===profile.priorityField?100:0)+
    (tasks.some(task=>!task.done&&task.fieldId===field.id)?10:0)}))
    .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,MAX_CONTEXT_FIELDS).map(item=>item.field);
}
function usable(part,kind,timestamp){
  return ['ready','cached'].includes(part?.status)&&part.source?.id===SOURCES[kind].id&&part.data&&
    recent(part.fetchedAt,timestamp,TTL[kind])&&Number.isFinite(time(part.validUntil))&&time(part.validUntil)>timestamp&&
    time(part.validUntil)-time(part.fetchedAt)<=TTL[kind]+1000;
}
function sameLocation(result,field){try{return result?.fieldId===field.id&&result.locationKey===locationKey(field);}catch{return false;}}
function source(kind,part){return {...SOURCES[kind],fetchedAt:part.fetchedAt};}
function enrichFieldBrief(brief,{profile={},fields=[],farmContexts=[],satelliteContexts=[],contextFields=[],satelliteFields=[],previousBrief=null,timestamp=Date.now()}={}){
  if(!contextFields.length&&!satelliteFields.length)return brief;
  const es=brief.language==='es',tr=(en,sp)=>es?sp:en;
  const scores={alert:100,freeze:85,wind:70,rain:60,unavailable:45,setup:40,conditions:10};
  const candidates=(brief.advisories||[]).map(item=>({...item,_score:item.kind?.startsWith('alert-')?100:item.kind?.startsWith('task-')?55:scores[item.kind]||20}));
  const summaries=[],notices=[...(brief.coverage?.notices||[])];
  function add(field,kind,score,part,details){candidates.push({id:`${field.id}-${kind}`,fieldId:field.id,fieldName:clean(field.name,'Field'),kind,
    priority:score>=80?'high':score>=40?'medium':'low',confidence:'medium',validUntil:part.validUntil,sources:[],
    followUp:tr('Why this field priority?','¿Por qué esta prioridad?'),...details,_score:score});}
  for(const id of contextFields.map(field=>field.id)){
    const field=fields.find(item=>item.id===id&&item.contextConsent===true),data=farmContexts.find(item=>item?.fieldId===id);
    if(!field||!sameLocation(data,field)){notices.push(tr(`Farm context was not available for ${clean(field?.name,'a selected field')}.`,`No se pudo consultar el contexto de ${clean(field?.name,'una parcela seleccionada')}.`));continue;}
    const available=Object.keys(SOURCES).filter(kind=>usable(data[kind],kind,timestamp));
    const summary={fieldId:id,locationKey:data.locationKey,availableSources:available,sourceStatus:Object.fromEntries(Object.keys(SOURCES).map(kind=>[kind,usable(data[kind],kind,timestamp)?'available':data[kind]?.status||'unavailable']))};
    summaries.push(summary);
    const missing=Object.keys(SOURCES).filter(kind=>!available.includes(kind));
    if(missing.length)notices.push(tr(`${field.name}: ${missing.map(kind=>SOURCES[kind].name).join(', ')} not available or not configured. Missing data are not an all-clear.`,`${field.name}: ${missing.map(kind=>SOURCES[kind].name).join(', ')} no disponibles o sin configurar. La falta de datos no indica ausencia de peligro.`));
    if(available.includes('air')){
      const part=data.air,observations=Array.isArray(part.data.observations)?part.data.observations:[];
      const air=observations.filter(item=>['PM2.5','PM10','O3'].includes(item.pollutant)&&finite(item.aqi)&&item.aqi>=0&&item.aqi<=500&&recent(item.observedAt,timestamp,4*HOUR)).sort((a,b)=>b.aqi-a.aqi)[0];
      if(air&&air.aqi>100){
        summary.air={pollutant:air.pollutant,aqi:air.aqi,observedAt:air.observedAt,reportingArea:air.reportingArea};
        add(field,'air-awareness',air.aqi>150?82:75,part,{sources:[source('air',part)],
          title:tr('Review regional air quality','Revise la calidad del aire regional'),
          whatChanged:tr(`${air.reportingArea}: ${air.pollutant} AQI ${air.aqi}, ${air.category}, observed ${air.observedAt}. This is a reporting-area observation, not a field sensor.`,`${air.reportingArea}: AQI de ${air.pollutant} ${air.aqi}, ${air.category}, observado ${air.observedAt}. Es un dato regional, no un sensor de la parcela.`),
          whyItMatters:tr('AirNow data are preliminary awareness information. AQI is not pollutant concentration and does not establish worker-safety compliance.','Los datos de AirNow son preliminares. El AQI no es concentración de contaminantes ni determina el cumplimiento de seguridad laboral.'),
          suggestedAction:tr('Review current AirNow observations and Washington L&I guidance before planning outdoor work.','Revise AirNow y los requisitos actuales de Washington L&I antes de planificar trabajo al aire libre.'),
          validUntil:new Date(Math.min(time(part.validUntil),time(air.observedAt)+4*HOUR)).toISOString()});
      }
    }
    if(available.includes('water')){
      const part=data.water,areas=Array.isArray(part.data.areas)?part.data.areas:[];
      const area=part.data.year===new Date(timestamp).getUTCFullYear()?areas.find(item=>['Drought Advisory Area','Drought Emergency Declaration Area'].includes(item.status)):null;
      if(area)add(field,'regional-drought',58,part,{sources:[source('water',part)],title:tr('Regional drought context','Contexto regional de sequía'),
        whatChanged:tr(`Ecology's ${part.data.year} map lists ${clean(area.watershed)} as ${area.status}. No change since yesterday is assumed.`,`El mapa ${part.data.year} de Ecology indica ${clean(area.watershed)}: ${area.status}. No se supone un cambio desde ayer.`),
        whyItMatters:tr('A regional declaration does not reveal your water right, irrigation allocation or water remaining.','Una declaración regional no revela sus derechos, asignación de riego ni agua restante.'),
        suggestedAction:tr('Check the Ecology notice and ask your irrigation district about your actual allocation.','Consulte el aviso de Ecology y su asignación real con el distrito de riego.')});
    }
    if(available.includes('markets')){
      const part=data.markets,items=Array.isArray(part.data.items)?part.data.items:[],latest=items.find(item=>typeof item.date==='string'&&/^\d{4}-\d\d-\d\d$/.test(item.date)&&recent(`${item.date}T00:00:00Z`,timestamp,15*DAY));
      if(latest&&part.data.reportId===field.marketReportId){
        summary.market={reportId:part.data.reportId,date:latest.date};
        const prior=previousBrief?.contextSummaries?.find(item=>item.fieldId===id&&item.locationKey===data.locationKey&&item.market?.reportId===part.data.reportId);
        const newer=prior?.market?.date&&latest.date>prior.market.date;
        add(field,'market-report',newer?46:25,part,{sources:[source('markets',part)],title:tr(newer?'New selected market report':'Your selected market report',newer?'Nuevo informe del mercado elegido':'Su informe del mercado elegido'),
          whatChanged:tr(`USDA report ${part.data.reportId} has quotes dated ${latest.date}${newer?`, newer than your saved report dated ${prior.market.date}`:''}.`,`El informe USDA ${part.data.reportId} tiene cotizaciones del ${latest.date}${newer?`, posteriores al informe guardado del ${prior.market.date}`:''}.`),
          whyItMatters:tr('You selected this report. Grade, origin, size, package and units can differ, so no like-for-like price movement or farm sale price is inferred.','Usted eligió este informe. Calidad, origen, tamaño, empaque y unidades pueden variar; no se infiere un cambio comparable ni el precio de venta de su finca.'),
          suggestedAction:tr('Open Farm Context to review the exact dated quotes and confirm details with your buyer.','Abra Contexto de la finca para revisar cotizaciones y confirmar los detalles con su comprador.')});
      }
    }
    if(available.includes('soil')){
      const part=data.soil,unit=Array.isArray(part.data.mapUnits)?part.data.mapUnits[0]:null;
      if(unit?.name)add(field,'soil-context',18,part,{sources:[source('soil',part)],title:tr('Mapped soil context','Contexto del suelo cartografiado'),
        whatChanged:tr(`USDA maps ${clean(unit.name)} at this field's representative point. This is survey context, not a new measurement.`,`USDA cartografía ${clean(unit.name)} en el punto representativo de la parcela. Es contexto del estudio, no una medición nueva.`),
        whyItMatters:tr('One point cannot establish soil conditions across the field or current soil moisture.','Un punto no determina las condiciones de toda la parcela ni la humedad actual.'),
        suggestedAction:tr('Review the soil components in Farm Context alongside your field observations before planning work.','Revise los componentes del suelo en Contexto junto con sus observaciones antes de planificar trabajos.')});
    }
  }
  for(const chosen of satelliteFields){
    const field=fields.find(item=>item.id===chosen.id&&(item.satelliteConsent===true||item.landsatConsent===true)&&item.boundary),combined=satelliteContexts.find(item=>item?.fieldId===chosen.id);
    if(!field||!sameLocation(combined,field))continue;
    // Source series remain independent: a Landsat value is never compared with
    // a Sentinel value. At most one satellite priority is emitted per field.
    const permitted=[...(field.satelliteConsent===true?[combined]:[]),...(field.landsatConsent===true&&combined.landsat?.source?.id==='nasa-landsat'?[combined.landsat]:[])].sort((a,b)=>(time(b.change?.currentDate)||0)-(time(a.change?.currentDate)||0));
    for(const data of permitted){
    if(!field||!sameLocation(data,field)||!['live','cached'].includes(data.status)||!recent(data.fetchedAt,timestamp,2*DAY)||!Number.isFinite(time(data.validUntil))||time(data.validUntil)<=timestamp)continue;
    const change=data.change;
    if(change?.status!=='detected'||!recent(change.currentDate,timestamp,21*DAY)||!recent(change.previousDate,timestamp,56*DAY)||time(change.currentDate)<=time(change.previousDate)||time(change.currentDate)-time(change.previousDate)>35*DAY||!finite(change.ndviDelta)||Math.abs(change.ndviDelta)>2||!finite(change.matchedPercent)||change.matchedPercent<70||change.matchedPercent>100||!Number.isInteger(change.matchedPixels)||change.matchedPixels<9)continue;
    const history=Array.isArray(data.history)?data.history.slice(-36):[];
    if(![change.previousDate,change.currentDate].every(date=>history.some(item=>item.date===date&&item.status==='clear'&&finite(item.ndvi)&&Math.abs(item.ndvi)<=1&&finite(item.clearPercent)&&item.clearPercent>=70&&item.clearPercent<=100&&finite(item.coveragePercent)&&item.coveragePercent>=90&&item.coveragePercent<=100)))continue;
    const validUntil=new Date(Math.min(time(data.validUntil),time(data.fetchedAt)+2*DAY,time(change.currentDate)+21*DAY)).toISOString();
    const sourceYears=[...new Set([change.previousDate,change.currentDate].map(date=>new Date(date).getUTCFullYear()))].sort();
    const evidenceSource=data===combined.landsat?{name:'NASA/USGS Landsat 8/9 via Microsoft Planetary Computer',url:'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-reflectance',fetchedAt:data.fetchedAt,attribution:'Landsat Collection 2 Level-2 surface reflectance, courtesy of the U.S. Geological Survey. No NASA or USGS endorsement.'}:{name:'Sentinel-2 L2A via Element84 Earth Search',url:'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a',fetchedAt:data.fetchedAt,attribution:`Contains modified Copernicus Sentinel data ${sourceYears.join(', ')}`};
    add(field,'satellite-scout',65,{validUntil},{sources:[evidenceSource],confidence:'medium',
      title:tr('A vegetation change is worth scouting','Un cambio de vegetación merece inspección'),
      whatChanged:tr(`Matched clear pixels changed by ${change.ndviDelta.toFixed(3)} NDVI index points between ${change.previousDate.slice(0,10)} and ${change.currentDate.slice(0,10)}.`,`Los píxeles claros comparables cambiaron ${change.ndviDelta.toFixed(3)} puntos NDVI entre ${change.previousDate.slice(0,10)} y ${change.currentDate.slice(0,10)}.`),
      whyItMatters:tr('This is a dated reflectance change, not proof of disease, water stress or yield loss. Harvest, crop stage and mixed pixels can change the signal.','Es un cambio de reflectancia fechado, no prueba de enfermedad, estrés hídrico ni pérdida de rendimiento. Cosecha, etapa y píxeles mixtos pueden cambiar la señal.'),
      suggestedAction:tr('Open satellite history, review the dated map and scout the field before deciding on any treatment.','Abra el historial satelital, revise el mapa fechado e inspeccione la parcela antes de decidir tratamientos.')});
    break;
    }
  }
  const chosen=candidates.sort((a,b)=>b._score-a._score).slice(0,3).map(({_score,...item})=>item);
  const contextIds=contextFields.map(field=>field.id),satelliteIds=satelliteFields.map(field=>field.id);
  const contextTotal=fields.filter(field=>field.contextConsent).length,satelliteTotal=fields.filter(field=>(field.satelliteConsent||field.landsatConsent)&&field.boundary).length;
  notices.push(tr(`Additional context: checked ${contextIds.length} of ${contextTotal} opted-in fields; satellite: reviewed saved results for ${satelliteIds.length} of ${satelliteTotal} opted-in boundaries. Missing or old results are not an all-clear. Open a field for fresh imagery.`,`Contexto adicional: ${contextIds.length} de ${contextTotal} parcelas autorizadas; satélite: resultados guardados de ${satelliteIds.length} de ${satelliteTotal} límites autorizados. Los datos faltantes o antiguos no indican ausencia de peligro.`));
  return {...brief,schemaVersion:3,engine:'phase123-rules',advisories:chosen,items:chosen.map(item=>`${item.fieldName} — ${item.title}: ${item.whatChanged}`),
    summary:tr(`${clean(profile.firstName,'Farmer')}, ${chosen.length} priorities to review for ${clean(profile.farmName,'your farm')}.`,`${clean(profile.firstName,'Agricultor')}, ${chosen.length} prioridades para revisar en ${clean(profile.farmName,'su finca')}.`),
    contextSummaries:summaries,coverage:{...brief.coverage,contextReviewedFieldIds:contextIds,satelliteCacheReviewedFieldIds:satelliteIds,notices},
    explanation:tr('Priorities use recorded weather, tasks and permitted current context, plus previously processed satellite evidence. Rules do not diagnose crops or determine legal compliance. NASS and annual crop classifications are background context; no sensors or equipment are connected.','Las prioridades usan tiempo, tareas y contexto autorizado, además de evidencia satelital procesada previamente. Las reglas no diagnostican cultivos ni determinan cumplimiento legal. NASS y clasificaciones anuales son contexto; no hay sensores ni equipos conectados.')};
}
module.exports={enrichFieldBrief,selectIntelligenceFields,MAX_CONTEXT_FIELDS,usable};
