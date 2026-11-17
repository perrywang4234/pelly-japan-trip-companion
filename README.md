# Trip Companion

An offline-first phone app for a two-week Japan trip. It installs to the iPhone Home Screen, works in airplane mode, and syncs edits between two phones through a private Google Sheet.

- **Days**: the itinerary, day by day. Tap any item to edit its time, details, confirmation number or status. Add your own items and per-day notes.
- **Bookings**: everything with a confirmation number or still marked "to do".
- **Hotels**: addresses, confirmation numbers and a full-screen Japanese taxi card for each hotel.
- **Log**: coin lockers and luggage forwarding (what, where, locker #/PIN, collected), plus a yen expense log split by who paid.
- **More**: sync settings, the pre-trip checklist and the Haneda arrival steps.

**No trip details are in this repo.** The itinerary, hotels, confirmation numbers and notes all live in a private Google Sheet (tab `AppSync`, rows starting `base:`). A phone downloads them the first time it connects with the passcode and keeps them for offline use. Opened without connecting, the app is an empty shell.

To change the base itinerary, edit the JSON in the `base:day:YYYY-MM-DD` rows (or just edit items in the app, which is easier).

## How sync works

Edits save on the phone immediately. When there's a connection, the app sends them to a small Apps Script attached to the Google Sheet (tab `AppSync`) and pulls down the other phone's edits. Each field merges separately: if both phones change the same field, the later edit wins. Editing a value directly in the `AppSync` tab also reaches both phones.

## Setup (one time, ~15 minutes)

### 1. Deploy the sync script (laptop)
1. Open the planner Google Sheet → **Extensions → Apps Script**.
2. Delete what's in `Code.gs`, paste in [`apps-script/Code.gs`](apps-script/Code.gs), and click **Save**.
3. Click **Deploy → New deployment** → gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (the passcode in the `AppConfig` tab protects it)
4. Click **Deploy**, approve the permissions prompt (Advanced → Go to project → Allow), and **copy the Web app URL** (ends in `/exec`).

### 2. Install on your phone
1. Open the app link in **Safari**, tap **Share → Add to Home Screen**.
2. Open it from the Home Screen → **More**.
3. Paste the Web app URL, enter the passcode from the sheet's `AppConfig` tab (cell B1), type your name, then **Connect & sync**. The trip loads.

### 3. Install on the other phone
1. On your phone: **More → Setup code for the other phone → Copy**, and send it by iMessage.
2. On the other phone: Safari → app link → **Add to Home Screen**, open it, **More**, paste the code, type her name, **Connect & sync**.

## Updating the app
Push changes to `main`; GitHub Pages redeploys. Bump `VERSION` in `sw.js` so phones pick up the new files on their next launch, or the launch after.

If you redeploy the Apps Script, use **Deploy → Manage deployments → Edit → New version** to keep the same URL.
