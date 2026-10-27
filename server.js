// Local server for the CSM Takeover Dashboard: `npm start`, then open http://localhost:3000.
// Data is kept in data/. Set DASHBOARD_PASSWORD in .env to require the shared password here too.
// `npm run demo` loads the demo cases instead of PMS data.
const http = require('http');
const path = require('path');
const { createApp } = require('./lib/app');
const { fileStorage } = require('./lib/storage');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const demo = process.argv.includes('--demo');

const app = createApp({ storage: fileStorage(DATA_DIR) });

(async () => {
  const r = await app.prepare({ demo });
  if (r.demo) console.log(`Loaded demo data: ${r.demo} cases`);
  if (r.removedDemo) console.log(`Removed ${r.removedDemo} demo cases`);
  http.createServer(app.handle).listen(PORT, HOST, () => {
    console.log(`CSM Takeover Dashboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data folder: ${DATA_DIR}`);
    if (!demo) app.runSync().catch(e => console.error('PMS sync:', e.message));
  });
})();
