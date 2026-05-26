# Creosote Apps Online Deployment

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

