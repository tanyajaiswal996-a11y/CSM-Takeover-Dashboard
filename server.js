// Local server for the CSM Takeover Dashboard. No dependencies: run `node server.js`.
// Serves the dashboard page and a small JSON API; data is kept in data/db.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kites = require('./kites');

const ROOT = __dirname;
const PAGE = path.join(ROOT, 'csm-takeover-dashboard.html');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const COLLECTIONS = ['cases', 'batches'];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 1024 * 1024;

// The page has no <head> of its own (the claude.ai viewer adds one), so wrap it here.
const SKELETON_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '</head><body>';

// Demo data comes from the same seed() generator the page uses, so both stay in step.
function buildSeed() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const head = script.slice(0, script.indexOf('/* ---------- state ----------'));
  const data = vm.runInNewContext(head + '; seed();', {});
  const db = {};
  for (const col of COLLECTIONS) db[col] = Object.fromEntries(data[col].map(x => [x.id, x]));
  return db;
}

function loadDb() {
  if (process.argv.includes('--reset') || !fs.existsSync(DB_FILE)) {
    const db = buildSeed();
    saveDb(db);
    console.log(`Loaded demo data: ${Object.keys(db.cases).length} cases, ${Object.keys(db.batches).length} batches`);
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  for (const col of COLLECTIONS) db[col] = db[col] || {};
  return db;
}

// Write to a temp file first so a crash mid-write never leaves a half-written db.json.
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const db = loadDb();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// GET /api/employees[?department=Sales][&refresh=1] — Employee Master from the PMS API
async function handleEmployees(req, res, url) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (!kites.configured()) return send(res, 503, { error: 'The employee API is not set up. Add the KITES_* settings to the .env file.' });
  try {
    const { at, employees, codeError } = await kites.getEmployees({ refresh: url.searchParams.get('refresh') === '1' });
    const dept = (url.searchParams.get('department') || '').trim().toLowerCase();
    const list = dept ? employees.filter(e => (e.department || '').toLowerCase() === dept) : employees;
    send(res, 200, { fetchedAt: at, total: employees.length, count: list.length, codeError, employees: list });
  } catch (e) {
    console.error('Employee API:', e.message);
    send(res, 502, { error: 'Could not load employees from PMS. ' + e.message });
  }
}

async function handleApi(req, res, parts, url) {
  const [col, rawId] = parts;
  if (col === 'employees' && rawId === undefined) return handleEmployees(req, res, url);
  if (!COLLECTIONS.includes(col)) return send(res, 404, { error: 'Unknown collection' });

  if (rawId === undefined) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    return send(res, 200, Object.values(db[col]));
  }

  const id = decodeURIComponent(rawId);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'Invalid id' });

  if (req.method === 'PUT') {
    let doc;
    try { doc = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Body must be a JSON object under 1 MB' }); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.id !== id) return send(res, 400, { error: 'Body must be a JSON object whose id matches the URL' });
    db[col][id] = doc;
    saveDb(db);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') {
    delete db[col][id];
    saveDb(db);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    return db[col][id] ? send(res, 200, db[col][id]) : send(res, 404, { error: 'Not found' });
  }
  return send(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') return await handleApi(req, res, parts.slice(1), url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // read on every request so edits to the page show up on refresh
      return send(res, 200, SKELETON_HEAD + fs.readFileSync(PAGE, 'utf8') + '</body></html>', 'text/html; charset=utf-8');
    }
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CSM Takeover Dashboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data file: ${DB_FILE}`);
});
