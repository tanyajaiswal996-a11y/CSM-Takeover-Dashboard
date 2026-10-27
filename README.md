# CSM Takeover Dashboard

Tracks a CSM takeover from the PMS resignation through 24-hour bidding, Sakshi's decision, the revised target and handover. When several CSMs resign together, their takeovers run as one batch.

## Online (Vercel)

The dashboard runs at https://csm-takeover-dashboard.vercel.app behind one shared password. Every request goes through `api/index.js`; without a valid sign-in nothing but the sign-in page is returned. Cases and saved employee codes are kept in a **private** Vercel Blob store.

One-time setup in the Vercel project:

1. **Storage → Create → Blob**, choose **Private**, and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`.
2. **Settings → Environment Variables**: add every setting from `.env.example` with your values, including `DASHBOARD_PASSWORD`.
3. **Deployments → Redeploy**.

Until the password and Blob store are set up, the site only shows a "not set up yet" message. Changing `DASHBOARD_PASSWORD` (and redeploying) signs everyone out.

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
| `lib/auth.js` | Shared-password sign-in with a signed, HttpOnly session cookie (7 days) |
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
