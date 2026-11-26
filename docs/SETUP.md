# Setup and privacy boundaries

## Local checks

Install Node.js 22 or newer, then follow the README commands. `npm test` runs offline tests. Live source checks are opt-in and should not be enabled just to review the submission. Do not copy private environment files or production databases into a review environment.

Optional browser checks use an isolated local profile and fixtures. Set `CHROME_PATH` if Chrome is installed outside the default Windows location. For example:

```sh
node tests/access-browser-smoke.cjs
node tests/phase-one-browser-smoke.cjs
node tests/field-map-integration-browser.cjs
node tests/ai-brief-browser.cjs
node tests/messaging-browser.cjs
node tests/focused-views-browser.cjs
```

The synthetic presenter-server source is retained only for its existing offline tests. Recorded videos, capture data and paid-provider test inputs are not included. Do not use a fixture server as a production authentication boundary or describe mocked results as live provider results.

On Windows, the browser tests use the usual Chrome installation path by default. For another installation, set its executable path in your terminal before running a browser test:

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/phase-one-browser-smoke.cjs
```

On macOS/Linux, set `CHROME_PATH` to your Chrome or compatible Chromium executable. These scripts launch hidden/headless browsers with temporary profiles, not your normal browser profile. The Phase 1 check exercises field editing, brief generation, source explanations and current-time greetings, then prints artifact locations. They are automated checks, not a persistent interactive demonstration server.

`npm start` is only a static preview and limited public-weather proxy. A sign-in gate on localhost is expected; its sign-in link takes you to the deployed Azure app. Full private-data functionality requires the cloud services below. A plain file server cannot securely replace them.

## Server configuration

The empty `.env.example` is documentation, not a working credential file. Each runtime needs its own explicit environment configuration; copying the file does not automatically load settings into Azure. Set production secrets only in protected server settings.

- `ADMIN_EMAILS`: a comma-separated allowlist of administrator email identities. Leave empty to grant no administrator access. Only the trusted Azure Static Web Apps Microsoft identity is accepted; a profile field, request body or browser preference cannot confer administrator status.
- `APP_ORIGIN`: the intended HTTPS application origin. Source retains the original public application's URL in some redirects and scheduler safeguards; review these explicitly before deploying a separate installation.
- `COSMOS_CONNECTION_STRING`: a server-only Cosmos DB connection string. The API uses database `farmer-daily`, container `user-state`, with partition key `/userId`; see `api/shared/store.js` and `infra/main.bicep`. Never put a connection string in browser code, Git commits or a screenshot.
- Optional AI: server-only provider key, explicit model configuration, positive approved daily budget, and per-request farmer consent. A key alone is not permission to run paid requests. Public-copy defaults are disabled.
- Optional SMS/WhatsApp: an adult-approved provider account, registered sender, encryption key, callbacks, own-number verification and consent. A configured flag is not proof of delivery. Production templates and deliberate scheduler activation are separate requirements. Never run the dispatch script as a status check.
- Optional calendars: provider app registration, exact callback URLs, encryption, separate consent and per-event approval. No email-send or automatic-calendar-sync claim is made.

Do not run deployment, paid live-provider checks or the schedule runner merely to inspect this code. Infrastructure templates are reference material; creating resources can incur charges.

## Full cloud installation prerequisites

The application is designed for Azure Static Web Apps with its managed Node.js Functions API and trusted authentication headers. A separate installation needs its own Azure account, Static Web App, Cosmos database/container, Microsoft sign-in and protected server settings. The reference template in `infra/main.bicep` describes those resources; review its settings and potential costs with the account owner before provisioning. Deploy the `dist` client output and the `api` directory together, with Node.js 22 support. Do not upload this entire repository as static assets.

Review `staticwebapp.config.json` authentication routes and every retained original-site URL before using another domain. Set the new app's server configuration explicitly, including `ADMIN_EMAILS` only if administrator access is wanted. Blank admin configuration intentionally grants nobody administrative access. A full deployment is not implied by a successful local build.

After deployment, verify unauthenticated private requests require sign-in, an ordinary user cannot become an administrator by editing profile data, and two accounts cannot read one another's records. Then test creating/editing a fictional field, saving a task and building a brief. Only configure optional provider integrations after these core checks work and the account owner has approved their data use and costs.

## Data sources and limitations

NOAA/NWS supplies weather forecasts/observations; USGS supplies elevation. NASA/USGS Landsat and Copernicus Sentinel-2 supply dated observations processed into vegetation indicators, not a disease diagnosis. Soil, markets, statistics, air quality and water context depend on individual adapter coverage, source availability and any required keys. Licensed university decision models, CPC drought outlooks and NASA SMAP are not claimed as completed integrations.

## Before publication

Keep the original private repository private. Upload only this reviewed snapshot to a separate repository without importing personal/private history. Use an honestly dated public baseline and genuine subsequent changes, not fabricated historical commits. Use GitHub's private/noreply commit-email setting. Do not upload `.env`, credential caches, raw recordings, captured farm data, private review reports, `node_modules`, or generated `dist`. Keep the MIT license and vendor notices. Repository visibility changes and source uploads are separate from app deployment. Confirm with the organizers whether a sanitized public baseline satisfies their history requirement before claiming eligibility.
