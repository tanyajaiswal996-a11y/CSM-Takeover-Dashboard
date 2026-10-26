# CSM Takeover Dashboard (local prototype)

Tracks a CSM takeover from the PMS resignation through 24-hour bidding, Sakshi's decision, the revised target and handover. When several CSMs resign together, their takeovers run as one batch.

## Run it

Needs Node.js 18 or later. There is nothing to install.

```bash
npm start
```

Then open http://localhost:3000.

On first start the server loads demo data (10 cases, 2 batches) into `data/db.json`. Every change you make in the dashboard is saved there.

## Employee Master (PMS API)

The **Employee master** page lists employees from the PMS "Get Employee Details" API, showing the Sales team by default.

1. Copy `.env.example` to `.env`.
2. Fill in the username, password, role and API key for both APIs: Get Employee Details (`KITES_*`) and Get Employee Code by Email (`KITES_CODE_*`).
3. Restart the server.

For each API the server logs in to get an access token and device token, then calls it. The employee details API has no employee code, so each employee's official email is looked up in the code-by-email API (5 at a time). Codes found are saved in `data/employee-codes.json`, so later loads only look up new emails.

Only code, name, department, designation, manager, email and joining/resignation dates are passed to the browser. Bank, address, phone and other personal fields stay on the server. Results are cached for 10 minutes; **Refresh from PMS** reloads them.

## Reset the demo data

Either click **Reset demo data** in the left panel, or stop the server and run:

```bash
npm run reset
```

This replaces everything in `data/db.json` with fresh demo cases, and refreshes their dates and countdowns.

## Options

- Another port, in PowerShell: `$env:PORT=4000; npm start` (macOS/Linux: `PORT=4000 npm start`).
- Let other computers on your network open it at `http://<your-ip>:3000`, in PowerShell: `$env:HOST="0.0.0.0"; npm start` (macOS/Linux: `HOST=0.0.0.0 npm start`). Windows may ask you to allow Node.js through the firewall.

## Files

| File | What it is |
| --- | --- |
| `csm-takeover-dashboard.html` | The whole dashboard (UI, logic, demo data generator) |
| `server.js` | Serves the page and a JSON API: `GET /api/cases`, `PUT /api/cases/<id>`, `DELETE /api/cases/<id>` (same for `batches`), and `GET /api/employees?department=Sales` |
| `kites.js` | Client for the PMS employee API: login, employee list, removal of personal fields |
| `.env.example` | Template for the API settings. Copy to `.env` (not committed) |
| `data/db.json` | Saved cases and batches. Delete it to start over with demo data |

The same HTML file also runs as the published claude.ai version, where data is kept in the artifact's shared database instead.

## Not included yet

- Logins and real roles. The "Viewing as" menu switches between HR, Sakshi and a CSM view for the demo.
- Using Employee Master data when starting a takeover. "New takeover from PMS" still uses demo resignations.
- Poll platform and Outlook integrations. These steps are simulated.
