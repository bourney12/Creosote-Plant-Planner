# Creosote Apps Online Deployment

## Recommended: run the server app

The fastest setup is now the Node server in `server/index.js`.

It serves the existing planner HTML files and exposes `/api/bridge`, a compatible bridge endpoint that:

- caches the Treatment Master payload centrally so every browser is not waiting on Google Apps Script;
- serves stale cached master data while a background refresh checks for updates;
- stores live board actuals/gaps locally and syncs them back to the existing Apps Script bridge;
- keeps the old Apps Script bridge as the upstream source of truth during migration.

Local run:

```bash
npm install
npm start
```

Then open:

- Main planner: `http://localhost:3000/creosote-planner-live.html`
- Operator logging: `http://localhost:3000/creosote-operator-charge-log.html`
- Live board: `http://localhost:3000/creosote-live-board.html`

Production deployment:

- `render.yaml` is included for Render Blueprint deployment.
- Set `MASTER_BRIDGE_URL` to the Apps Script `/exec` URL if it changes.
- The server health check is `/api/health`.

When hosted from the server, the apps automatically use `/api/bridge`. When hosted from GitHub Pages, they continue to fall back to the existing Apps Script bridge.

## 1. Redeploy the Google bridge

Copy the full contents of `production-master-bridge.gs` into the existing Google Apps Script project.

Deploy it as a web app:

- Execute as: Me
- Who has access: Anyone
- URL must end in `/exec`

Use **Manage deployments** and edit the existing web app if possible, so the URL stays the same:

`https://script.google.com/macros/s/AKfycbx1MO2PmRD7jkoFeKhIjAiSC5vOF6tMrVAXaKO-AU8jZF21e7upIG5BEr6V4ABz8atw/exec`

The bridge now does two jobs:

- Pulls the latest Treatment Master and Inventory Movements data.
- Stores live operator charge actuals and gap reasons so all screens update from the same source.

## 2. Upload the static app files

Upload these files and folders to a static web host:

- `creosote-planner-live.html`
- `creosote-operator-charge-log.html`
- `creosote-live-board.html`
- `assets/`

Suitable hosts:

- Netlify
- Cloudflare Pages
- GitHub Pages
- SharePoint static hosting, if allowed by IT
- Any internal IIS/static web server

No server-side code is needed for the HTML files. The live data is handled by the Google Apps Script bridge.

## 3. Public app links

After upload, the three user links should be:

- Main planner: `https://YOUR-SITE/creosote-planner-live.html`
- Operator logging: `https://YOUR-SITE/creosote-operator-charge-log.html`
- Live board: `https://YOUR-SITE/creosote-live-board.html`

## 4. Live update behaviour

- Operator charge start/finish/type/gap entries are pushed to the bridge immediately.
- Planner and live board screens poll the bridge every 5 seconds.
- Treatment Master data refreshes every 5 minutes in the browser.
- Local browser storage remains as a fallback if the bridge is temporarily unavailable.

