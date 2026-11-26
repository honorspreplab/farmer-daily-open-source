import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateApiPackage } from './validate-api-package.cjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
validateApiPackage();
// Pin and serve the map library locally; do not run third-party CDN scripts.
await mkdir(resolve(root, 'vendor'), { recursive: true });
for (const file of ['leaflet.js', 'leaflet.css']) await cp(resolve(root, 'node_modules/leaflet/dist', file), resolve(root, 'vendor', file));
await cp(resolve(root, 'node_modules/leaflet/LICENSE'), resolve(root, 'vendor/leaflet-LICENSE.txt'));
await cp(resolve(root, 'node_modules/leaflet/dist/images'), resolve(root, 'vendor/images'), { recursive: true });
await cp(resolve(root, 'api/shared/field-geometry.js'), resolve(root, 'field-geometry.js'));
await cp(resolve(root, 'api/shared/build-progress.js'), resolve(root, 'build-progress.js'));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ['index.html', 'styles.css', 'themes.css', 'reading.css', 'farm-intelligence.js', 'farm-intelligence.css', 'connected-farm.js', 'connected-farm.css', 'onboarding.css', 'pwa.css', 'weather.css', 'weather-ui.js', 'membership.js', 'membership.css', 'admin.html', 'admin.js', 'admin.css', 'app.js', 'farm-workspace.js', 'farm-workspace.css', 'work-plan.js', 'field-flow.js', 'field-flow.css', 'field-map.js', 'field-map.css', 'field-geometry.js', 'build-progress.js', 'phase-one.js', 'phase-one.css', 'phase-schedule.js', 'dev-status.html', 'dev-status.js', 'manifest.webmanifest', 'service-worker.js', 'offline.html', 'staticwebapp.config.json']) {
  await cp(resolve(root, file), resolve(output, file));
}
await cp(resolve(root, 'vendor'), resolve(output, 'vendor'), { recursive: true });
await cp(resolve(root, 'icons'), resolve(output, 'icons'), { recursive: true });
for (const file of ['calendar-connections.js','calendar-connections.css','calendar-callback.html','calendar-callback.js','calendar-callback.css']) await cp(resolve(root, file), resolve(output, file));
for (const file of ['messaging.js','messaging.css']) await cp(resolve(root, file), resolve(output, file));
for (const file of ['ai-brief.js','ai-brief.css']) await cp(resolve(root, file), resolve(output, file));
for (const file of ['brief-voice.js','brief-voice.css','focused-views.js','focused-views.css']) await cp(resolve(root, file), resolve(output, file));

console.log(`Built Farmer Daily web client in ${output}`);
