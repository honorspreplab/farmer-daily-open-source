const http = require('http');
const fs = require('fs');
const path = require('path');
const weather = require('./api/weather');

const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const publicFiles = new Set(['index.html','app.js','styles.css', 'themes.css', 'reading.css','onboarding.css','pwa.css','weather.css','weather-ui.js','membership.js','membership.css','farm-workspace.js','farm-workspace.css','work-plan.js','field-flow.js','field-flow.css','field-map.js','field-map.css','field-geometry.js','build-progress.js','phase-one.js','phase-one.css','phase-schedule.js','dev-status.html','dev-status.js','vendor/leaflet.js','vendor/leaflet.css','vendor/leaflet-LICENSE.txt','admin.html','admin.js','admin.css','manifest.webmanifest','service-worker.js','offline.html']);
publicFiles.add('farm-intelligence.js');publicFiles.add('farm-intelligence.css');
publicFiles.add('connected-farm.js');publicFiles.add('connected-farm.css');
for (const file of ['calendar-connections.js','calendar-connections.css','calendar-callback.html','calendar-callback.js','calendar-callback.css']) publicFiles.add(file);
for (const file of ['messaging.js','messaging.css']) publicFiles.add(file);
for (const file of ['ai-brief.js','ai-brief.css']) publicFiles.add(file);
for (const file of ['brief-voice.js','brief-voice.css','focused-views.js','focused-views.css']) publicFiles.add(file);

http.createServer(async (req,res)=>{
  const route=req.url.split('?')[0];
  if(route==='/.auth/login/aad'){
    res.writeHead(302,{Location:'https://calm-desert-02e51f41e.1.azurestaticapps.net/.auth/login/aad?post_login_redirect_uri=/'});return res.end();
  }
  if(route==='/.auth/me'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({clientPrincipal:null}));
  }
  if(route.startsWith('/api/')&&route!=='/api/weather'){
    res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({error:'Sign in on the Azure site to use accounts, daily briefs, and administration.'}));
  }
  if(req.url.split('?')[0] === '/api/weather'){
    try{
      const requestUrl=new URL(req.url,'http://localhost');
      const context={log:{warn:message=>console.warn(message)}};
      await weather(context,{query:Object.fromEntries(requestUrl.searchParams)});
      res.writeHead(context.res.status || 200,context.res.headers);
      return res.end(JSON.stringify(context.res.body));
    }catch(error){
      console.error('Weather request failed. No farm or location information was logged.');
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(JSON.stringify({error:'Weather services temporarily unavailable. Please retry shortly.'}));
    }
  }
  let requested;
  try { requested = route === '/' ? 'index.html' : route === '/dev/status' ? 'dev-status.html' : /^\/calendar-callback\/(google|outlook)$/.test(route) ? 'calendar-callback.html' : decodeURIComponent(route).replace(/^\/+/, ''); }
  catch { res.writeHead(400);return res.end('Invalid path'); }
  if(!publicFiles.has(requested)&&!/^icons\/[a-zA-Z0-9_.-]+\.(png|svg)$/.test(requested)&&!/^vendor\/images\/[a-zA-Z0-9_.-]+\.png$/.test(requested)){res.writeHead(404);return res.end('Not found');}
  const file = path.resolve(__dirname, requested);
  const relative=path.relative(__dirname,file);
  if (relative.startsWith('..')||path.isAbsolute(relative)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (error,data)=>{
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store',...(requested.startsWith('calendar-callback')?{'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}:{})});
    res.end(data);
  });
}).listen(port, '127.0.0.1', ()=>console.log(`Farmer Daily preview at http://localhost:${port}; accounts use the Azure site.`));
