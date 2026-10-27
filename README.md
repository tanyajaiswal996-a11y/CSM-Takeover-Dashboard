# CSM Takeover Dashboard

Tracks a CSM takeover from the PMS resignation through 24-hour bidding, Sakshi's decision, the revised target and handover. When several CSMs resign together, their takeovers run as one batch.

## Online (Vercel)

The live dashboard runs at https://csm-takeover-dashboard.vercel.app and opens only through a **private share link** (no login screen). The link looks like `https://csm-takeover-dashboard.vercel.app/#access=<code>`. Opening it once stores an access cookie for 30 days; without it the site shows only "This dashboard is private" and no data. The code sits after `#`, so it never appears in server logs.

Every request goes through `api/index.js`. Cases and saved employee codes are kept in a **private** Vercel Blob store.

One-time setup in the Vercel project (already done):

1. **Storage → Create → Blob**, **Private**, connected to the project.
2. **Settings → Environment Variables → Import .env** with the `KITES_*` settings.

The share-link code is derived from the PMS API password stored in Vercel. To get it on your computer, run `npm run link`. To change the link (for example if it was shared too widely), add `ACCESS_KEY` with any new long random text in Vercel and redeploy: the old link and all existing access stop working.

## Run it on your computer

Needs Node.js 18 or later. There is nothing to install.

```bash
npm start
```

Then open http://localhost:3000.

Takeover cases come from PMS: every employee in the Sales department with a resignation date becomes a case. The server checks PMS when it starts, and **Sync from PMS** on the case list checks again. Resignations dated within 3 days of each other start together as one batch. Existing cases are never changed or removed by a sync. Every change you make in the dashboard is saved in `data/db.json`.

## Employee Master (PMS API)

The **Employee master** page lists employees from the PMS "Get Employee Details" API, showing the Sales team by default.

1. Copy `.env.example` to `.env`.
2. Fill in the username, password, role and API key for both APIs: Get Employee Details (`KITES_*`) and Get Employee Code by Email (`KITES_CODE_*`).
3. Restart the server.

For each API the server logs in to get an access token and device token, then calls it. The employee details API has no employee code, so each employee's official email is looked up in the code-by-email API (5 at a time). Codes found are saved in `data/employee-codes.json`, so later loads only look up new emails.

Only code, name, department, designation, manager, email and joining/resignation dates are passed to the browser. Bank, address, phone and other personal fields stay on the server. Results are cached for 10 minutes; **Refresh from PMS** reloads them.

## Demo data

To show the dashboard with sample cases (for a presentation), stop the server and run:

```bash
npm run demo
```

This replaces `data/db.json` with 10 demo cases and 2 batches. The next `npm start` removes the demo cases (their codes start with EMP-) and goes back to PMS data.

## Options

- Another port, in PowerShell: `$env:PORT=4000; npm start` (macOS/Linux: `PORT=4000 npm start`).
- Let other computers on your network open it at `http://<your-ip>:3000`, in PowerShell: `$env:HOST="0.0.0.0"; npm start` (macOS/Linux: `HOST=0.0.0.0 npm start`). Windows may ask you to allow Node.js through the firewall.

## Files

| File | What it is |
| --- | --- |
| `csm-takeover-dashboard.html` | The whole dashboard (UI, logic, demo data generator) |
| `api/index.js` | Vercel entry point: checks the setup, then hands every request to `lib/app.js` |
| `lib/app.js` | Request handling shared by Vercel and the local server: sign-in, cases, PMS sync, employees |
| `lib/auth.js` | Private share link: checks the link's code and sets a signed, HttpOnly access cookie (30 days) |
| `lib/storage.js` | Saves data to `data/` locally or to private Vercel Blob online |
| `server.js` | Local server: `npm start` runs `lib/app.js` with data saved in `data/` |
| `kites.js` | Clients for the PMS employee details and employee code APIs: login, employee list, code lookup by email, removal of personal fields |
| `.env.example` | Template for the API settings. Copy to `.env` (not committed) |
| `data/db.json` | Saved cases and batches. Delete it to start over from PMS |
| `data/employee-codes.json` | Saved employee codes by official email |

The same HTML file also runs as the published claude.ai version, where data is kept in the artifact's shared database instead.

## Not included yet

- Logins and real roles. The "Viewing as" menu switches between HR, Sakshi and a CSM view for the demo.
- Portfolio details (accounts and quarterly target) are not in PMS, so they show as "not in PMS".
- The bidder list (who can bid and their ceiling, index and PAPIP) is still sample data.
- Poll platform and Outlook integrations. These steps are simulated.
