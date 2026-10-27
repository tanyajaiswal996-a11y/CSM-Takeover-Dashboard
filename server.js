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

// Demo cases use made-up codes like EMP-11530; real PMS codes are numbers.
const isDemoCase = c => /^EMP-/.test((c.outgoing && c.outgoing.emp) || '');

// Default: real data only (demo cases are removed, PMS resignations are synced in).
// `npm run demo` (--demo) loads the demo cases instead, for presentations.
function loadDb() {
  const demo = process.argv.includes('--demo');
  if (demo) {
    const db = buildSeed();
    saveDb(db);
    console.log(`Loaded demo data: ${Object.keys(db.cases).length} cases, ${Object.keys(db.batches).length} batches`);
    return db;
  }
  const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
  for (const col of COLLECTIONS) db[col] = db[col] || {};
  const demoIds = Object.values(db.cases).filter(isDemoCase).map(c => c.id);
  if (demoIds.length) {
    demoIds.forEach(id => delete db.cases[id]);
    for (const b of Object.values(db.batches)) if (!Object.values(db.cases).some(c => c.batchId === b.id)) delete db.batches[b.id];
    console.log(`Removed ${demoIds.length} demo cases`);
  }
  saveDb(db);
  return db;
}

// Resignations in PMS's Sales department become takeover cases. Existing cases
// (matched by employee code) are never changed or removed. Resignations dated
// within 3 days of each other start together as one batch.
const BATCH_WINDOW_MS = 3 * 864e5;
let syncing = null;
async function syncFromPms() {
  if (!kites.configured()) return { added: 0, resigned: 0, note: 'Employee API is not set up in .env' };
  const { employees } = await kites.getEmployees();
  const have = new Set(Object.values(db.cases).map(c => c.outgoing && c.outgoing.emp));
  const resigned = employees.filter(e => (e.department || '').toLowerCase() === 'sales' && e.resignationDate);
  const fresh = resigned.filter(e => e.code && !have.has(e.code))
    .map(e => ({ e, resign: Date.parse(e.resignationDate) || Date.now(), lwd: Date.parse(e.lastWorkingDay) || null }))
    .sort((a, b) => a.resign - b.resign);
  if (!fresh.length) return { added: 0, resigned: resigned.length };

  const now = Date.now(), year = new Date().getFullYear();
  let seq = Math.max(0, ...Object.keys(db.cases).map(id => +(id.match(/-(\d+)$/) || [, 0])[1]));
  let batchSeq = Math.max(0, ...Object.keys(db.batches).map(id => +(id.match(/-(\d+)$/) || [, 0])[1]));
  const created = fresh.map(({ e, resign, lwd }) => {
    const id = `TKO-${year}-${String(++seq).padStart(3, '0')}`;
    return {
      id, outgoing: { name: e.name || 'Name not in PMS', emp: e.code, designation: e.designation || '' },
      pms: 'PMS ' + e.code, portfolio: { name: `${e.name || e.code}'s portfolio`, accounts: null, target: null },
      manager: e.manager || '—', resignDate: resign, lwd, owner: 'HR', createdAt: now, stage: 0, stageAt: { 0: now },
      exception: null, holdReason: '', batchId: null, bid: null, bids: [], packs: [], decision: null, incoming: null,
      target: null, tasks: [], comms: [], attachments: [], closedAt: null, source: 'pms',
      log: [{ at: now, by: 'PMS sync', text: `Case created from the PMS resignation of ${e.name || e.code} (employee code ${e.code})` }]
    };
  });
  // group resignations that came in close together
  let group = [];
  const flush = () => {
    if (group.length > 1) {
      const bid = `BAT-${year}-${String(++batchSeq).padStart(2, '0')}`;
      db.batches[bid] = { id: bid, createdAt: now, by: 'PMS sync' };
      group.forEach(c => { c.batchId = bid; c.log.push({ at: now, by: 'PMS sync', text: `Added to takeover batch ${bid} with ${group.filter(x => x !== c).map(x => x.outgoing.name).join(', ')}` }); });
    }
    group = [];
  };
  created.forEach(c => { if (group.length && c.resignDate - group[0].resignDate > BATCH_WINDOW_MS) flush(); group.push(c); });
  flush();
  created.forEach(c => { db.cases[c.id] = c; });
  saveDb(db);
  console.log(`PMS sync: added ${created.length} case(s)`);
  return { added: created.length, resigned: resigned.length };
}
const runSync = () => (syncing = syncing || syncFromPms().finally(() => { syncing = null; }));

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
  if (col === 'sync' && rawId === undefined) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    try { return send(res, 200, await runSync()); }
    catch (e) { console.error('PMS sync:', e.message); return send(res, 502, { error: 'Could not sync from PMS. ' + e.message }); }
  }
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
  if (!process.argv.includes('--demo')) runSync().catch(e => console.error('PMS sync:', e.message));
});
