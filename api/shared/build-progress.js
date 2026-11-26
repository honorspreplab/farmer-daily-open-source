(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.FarmerBuildProgress=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Maturity is recorded per capability; future integrations are not represented as live.
  return {
    version:'0.18.2', statuses:['Not started','Building','Working','Validated'],
    features:[
      {id:'farm',phase:0,name:'Private farm profile',status:'Validated',detail:'Owner-only profile, language and preferences; isolated API/browser checks passed.'},
      {id:'fields',phase:0,name:'Field map and boundaries',status:'Validated',detail:'Point, drawn/imported Polygon and optional basemap; geometry and mobile browser checks passed.'},
      {id:'weather',phase:1,name:'Field weather and alerts',status:'Validated',detail:'Consented point, NWS/fallback and outage states; provider fixtures and public API checks passed.'},
      {id:'elevation',phase:1,name:'USGS elevation',status:'Validated',detail:'Private point cache and invalidation tested; no slope/aspect or temperature correction.'},
      {id:'tasks',phase:1,name:'Field tasks',status:'Validated',detail:'Field-linked manual tasks, editing and completion checked in isolated API/browser tests.'},
      {id:'advisories',phase:1,name:'Three-item brief',status:'Validated',detail:'Rules, evidence and same-hour change comparisons tested; not an LLM or agronomic validation.'},
      {id:'ai-brief',phase:1,name:'Optional personalized AI message',status:'Building',detail:'Direct OpenAI Sol/Luna routing, permissioned read-only weather/satellite/context/task tools, per-request consent and shared spending reservations. Default off; local provider checks and production activation are separate. Not agronomic validation.'},
      {id:'questions',phase:1,name:'Text questions and voice',status:'Validated',detail:'English/Spanish answers, selectable free voices, pace and playback privacy checked with mocked speech. Voice quality still needs a device listening check; no paid TTS.'},
      {id:'schedule',phase:1,name:'Morning schedule while open',status:'Validated',detail:'Pacific/DST and daily deduplication tested; while open or on return; not background delivery.'},
      {id:'notifications',phase:1,name:'Browser notifications while open',status:'Working',detail:'User permission required; generic notification hides farm details.'},
      {id:'background',phase:1,name:'Closed-app scheduling and push',status:'Not started',detail:'Needs an authorized background worker and push setup beyond current managed HTTP APIs.'},
      {id:'messaging',phase:1,name:'SMS and WhatsApp daily briefs',status:'Building',detail:'Real provider adapter, verified own-number consent, delivery receipts, STOP and daily dispatch implemented. Provider account/senders, WhatsApp template, scheduler activation and real-phone validation are required; no messages sent by setup alone.'},
      {id:'soil',phase:2,name:'USDA NRCS soils',status:'Validated',detail:'Point survey passed provider and isolated privacy/UI checks. Not a field-wide survey or moisture sensor; availability may vary.'},
      {id:'markets',phase:2,name:'USDA market prices',status:'Building',detail:'Selected-report adapter implemented; administrator API key still required. No generic prices or unsupported price changes.'},
      {id:'statistics',phase:2,name:'USDA agricultural context',status:'Building',detail:'Washington annual NASS adapter implemented; administrator API key still required. Not a field harvest recommendation.'},
      {id:'air',phase:2,name:'Air quality and smoke',status:'Building',detail:'AirNow adapter implemented; administrator API key still required. Preliminary regional AQI, not safety compliance.'},
      {id:'water',phase:2,name:'Washington water and drought',status:'Building',detail:'Ecology adapter rejects older annual layers as current. A verified current-year layer is needed; no farm allocation inferred.'},
      {id:'satellite',phase:3,name:'Sentinel-2 vegetation history',status:'Validated',detail:'Real-pixel NDVI/NDRE pipeline and isolated privacy/UI checks passed. Dated scouting evidence, not disease diagnosis or a seasonal baseline.'},
      {id:'landsat',phase:3,name:'NASA/USGS Landsat vegetation history',status:'Validated',detail:'Live public pixels and isolated API/privacy/browser checks passed. Landsat 8/9 via Microsoft Planetary Computer; separate permission, 30 m NDVI, dated quality, no NDRE or cross-sensor comparison. Not agronomic validation.'},
      {id:'crop-history',phase:3,name:'USDA historical crop context',status:'Validated',detail:'Three annual point lookups and year/resolution checks passed. Not field-wide history or real-time crop health; coverage may vary.'},
      {id:'equipment-records',phase:4,name:'Private equipment register',status:'Validated',detail:'Owner-only equipment, irrigation details and service dates. No machinery control or live equipment feed.'},
      {id:'sensor-imports',phase:4,name:'Measured reading imports',status:'Validated',detail:'Optional manual/CSV readings; local date picker, inline save/error feedback, reload persistence and duplicates checked. Not live telemetry or calibrated agronomic advice.'},
      {id:'knowledge',phase:4,name:'Private farm knowledge',status:'Validated',detail:'Search your saved SOP/manual excerpts and notes. Literal text search, not an LLM or agronomic validation.'},
      {id:'sensors',phase:4,name:'Live farm-system connections',status:'Not started',detail:'Frontier Farm; provider-specific sensor/equipment connections and operational briefs require authorized actual systems.'},
      {id:'wsu',phase:4,name:'Licensed WSU integrations',status:'Not started',detail:'Frontier Farm; permission/licensing required before integration.'},
      {id:'internal-workflows',phase:5,name:'Approved farm workflows',status:'Validated',detail:'Server-checked proposals create/reschedule tasks and save records or unsent drafts. Expiry, conflict and duplicate-execution guards.'},
      {id:'calendar-export',phase:5,name:'Approved calendar-file download',status:'Validated',detail:'Download a reviewed task to import yourself. Not a connected calendar or automatic message.'},
      {id:'calendar-connections',phase:5,name:'Outlook and Google calendar connections',status:'Building',detail:'Calendar-only consent, encrypted credentials and explicit event approval implemented. Administrator provider setup and real-account validation still required; no email or automatic sync.'},
      {id:'actions',phase:5,name:'Other external agents and actions',status:'Not started',detail:'Email/buyer and compliance systems require provider setup and action-specific approval. No external messages, purchases or equipment commands.'}
    ]
  };
});
