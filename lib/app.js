// The dashboard's request handler, shared by the local server (server.js) and Vercel (api/index.js).
// Serves the page behind the shared password and the JSON API:
//   GET  /api/cases | /api/batches            list
//   PUT  /api/cases/<id>, DELETE /api/cases/<id>   (same for batches)
//   GET  /api/employees[?department=Sales][&refresh=1]
//   POST /api/sync                             create cases from PMS resignations
//   POST /api/login, POST /api/logout
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kites = require('../kites');
const auth = require('./auth');

const PAGE = path.join(__dirname, '..', 'csm-takeover-dashboard.html');
const DB_NAME = 'db.json';
const COLLECTIONS = ['cases', 'batches'];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 1024 * 1024;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const BATCH_WINDOW_MS = 3 * 864e5;

// The page has no <head> of its own (the claude.ai viewer adds one), so wrap it here.
const wrapPage = html => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">'
  + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
  + `<script>window.CTD_AUTH=${auth.enabled() ? 'true' : 'false'}</script>`
  + '</head><body>' + html + '</body></html>';

// Demo cases come from the same seed() generator the page uses, so both stay in step.
function buildSeed() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const data = vm.runInNewContext(script.slice(0, script.indexOf('/* ---------- state ----------')) + '; seed();', {});
  const db = { meta: {} };
  for (const col of COLLECTIONS) db[col] = Object.fromEntries(data[col].map(x => [x.id, x]));
  return db;
}
// Demo cases use made-up codes like EMP-11530; real PMS codes are numbers.
const isDemoCase = c => /^EMP-/.test((c.outgoing && c.outgoing.emp) || '');

function createApp({ storage, secureCookies = false, routeParam = null, codeBudgetMs = Infinity, cacheMs = 0 }) {
  // ---- data ----
  let memo = null; // { at, db } — on Vercel, re-read the stored copy at most every `cacheMs`
  const normalize = db => { db = db || {}; for (const col of COLLECTIONS) db[col] = db[col] || {}; db.meta = db.meta || {}; return db; };
  async function getDb({ fresh = false } = {}) {
    if (memo && !fresh && Date.now() - memo.at < cacheMs) return memo.db;
    if (memo && cacheMs === 0 && storage.kind === 'file') return memo.db; // local: memory copy is the source of truth
    const db = normalize(await storage.readJson(DB_NAME));
    memo = { at: Date.now(), db };
    return db;
  }
  async function saveDb(db) { await storage.writeJson(DB_NAME, db); memo = { at: Date.now(), db }; }
  // one write at a time, so two changes arriving together are applied in order
  let queue = Promise.resolve();
  const change = fn => (queue = queue.then(async () => { const db = await getDb({ fresh: true }); const out = await fn(db); await saveDb(db); return out; }));

  // Start-up housekeeping for the local server: remove demo cases, or load them with --demo.
  async function prepare({ demo = false } = {}) {
    if (demo) { const db = buildSeed(); await saveDb(db); return { demo: Object.keys(db.cases).length }; }
    return change(db => {
      const ids = Object.values(db.cases).filter(isDemoCase).map(c => c.id);
      ids.forEach(id => delete db.cases[id]);
      for (const b of Object.values(db.batches)) if (!Object.values(db.cases).some(c => c.batchId === b.id)) delete db.batches[b.id];
      return { removedDemo: ids.length };
    });
  }

  // ---- PMS ----
  const employees = (opts = {}) => kites.getEmployees({ storage, budgetMs: codeBudgetMs, ...opts });

  // Resignations in PMS's Sales department become takeover cases. Existing cases
  // (matched by employee code) are never changed or removed. Resignations dated
  // within 3 days of each other start together as one batch.
  async function syncFromPms() {
    if (!kites.configured()) return { added: 0, resigned: 0, note: 'The employee API is not set up.' };
    const { employees: list, codesPending } = await employees();
    return change(db => {
      db.meta.lastSync = Date.now();
      const have = new Set(Object.values(db.cases).map(c => c.outgoing && c.outgoing.emp));
      const resigned = list.filter(e => (e.department || '').toLowerCase() === 'sales' && e.resignationDate);
      const fresh = resigned.filter(e => e.code && !have.has(e.code))
        .map(e => ({ e, resign: Date.parse(e.resignationDate) || Date.now(), lwd: Date.parse(e.lastWorkingDay) || null }))
        .sort((a, b) => a.resign - b.resign);
      if (!fresh.length) return { added: 0, resigned: resigned.length, codesPending };
      const now = Date.now(), year = new Date().getFullYear();
      let seq = Math.max(0, ...Object.keys(db.cases).map(id => +(id.match(/-(\d+)$/) || [, 0])[1]));
      let batchSeq = Math.max(0, ...Object.keys(db.batches).map(id => +(id.match(/-(\d+)$/) || [, 0])[1]));
      const created = fresh.map(({ e, resign, lwd }) => ({
        id: `TKO-${year}-${String(++seq).padStart(3, '0')}`,
        outgoing: { name: e.name || 'Name not in PMS', emp: e.code, designation: e.designation || '' },
        pms: 'PMS ' + e.code, portfolio: { name: `${e.name || e.code}'s portfolio`, accounts: null, target: null },
        manager: e.manager || '—', resignDate: resign, lwd, owner: 'HR', createdAt: now, stage: 0, stageAt: { 0: now },
        exception: null, holdReason: '', batchId: null, bid: null, bids: [], packs: [], decision: null, incoming: null,
        target: null, tasks: [], comms: [], attachments: [], closedAt: null, source: 'pms',
        log: [{ at: now, by: 'PMS sync', text: `Case created from the PMS resignation of ${e.name || e.code} (employee code ${e.code})` }]
      }));
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
      console.log(`PMS sync: added ${created.length} case(s)`);
      return { added: created.length, resigned: resigned.length, codesPending };
    });
  }
  let syncing = null;
  const runSync = () => (syncing = syncing || syncFromPms().finally(() => { syncing = null; }));

  // ---- http ----
  const baseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': type, ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  function readBody(req) {
    if (req.body !== undefined) return Promise.resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)); // body already parsed by the platform
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function handleEmployees(req, res, url) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    if (!kites.configured()) return send(res, 503, { error: 'The employee API is not set up. Add the KITES_* settings.' });
    try {
      const { at, employees: list, codeError, codesPending } = await employees({ refresh: url.searchParams.get('refresh') === '1' });
      const dept = (url.searchParams.get('department') || '').trim().toLowerCase();
      const out = dept ? list.filter(e => (e.department || '').toLowerCase() === dept) : list;
      send(res, 200, { fetchedAt: at, total: list.length, count: out.length, codeError, codesPending, employees: out });
    } catch (e) {
      console.error('Employee API:', e.message);
      send(res, 502, { error: 'Could not load employees from PMS. ' + e.message });
    }
  }

  async function handleApi(req, res, parts, url) {
    const [col, rawId] = parts;
    if (col === 'login') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      let pw = '';
      try { pw = JSON.parse((await readBody(req)) || '{}').password || ''; } catch (e) {}
      if (!auth.checkPassword(pw)) { await sleep(800); return send(res, 401, { error: 'Wrong password' }); } // slow down guessing
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.sessionCookie(secureCookies) });
    }
    if (col === 'logout') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.clearCookie(secureCookies) });
    if (!auth.isSignedIn(req)) return send(res, 401, { error: 'Sign in first' });

    if (col === 'employees' && rawId === undefined) return handleEmployees(req, res, url);
    if (col === 'sync' && rawId === undefined) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      try { return send(res, 200, await runSync()); }
      catch (e) { console.error('PMS sync:', e.message); return send(res, 502, { error: 'Could not sync from PMS. ' + e.message }); }
    }
    if (!COLLECTIONS.includes(col)) return send(res, 404, { error: 'Not found' });

    if (rawId === undefined) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const db = await getDb();
      // keep cases in step with PMS without a background job: check at most every 10 minutes
      if (col === 'cases' && Date.now() - (db.meta.lastSync || 0) > SYNC_EVERY_MS && kites.configured()) {
        try { await runSync(); } catch (e) { console.error('PMS sync:', e.message); }
        return send(res, 200, Object.values((await getDb()).cases));
      }
      return send(res, 200, Object.values(db[col]));
    }

    const id = decodeURIComponent(rawId);
    if (!ID_RE.test(id)) return send(res, 400, { error: 'Invalid id' });
    if (req.method === 'PUT') {
      let doc;
      try { doc = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Body must be a JSON object under 1 MB' }); }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.id !== id) return send(res, 400, { error: 'Body must be a JSON object whose id matches the URL' });
      await change(db => { db[col][id] = doc; });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await change(db => { delete db[col][id]; });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const db = await getDb();
      return db[col][id] ? send(res, 200, db[col][id]) : send(res, 404, { error: 'Not found' });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const routed = routeParam ? url.searchParams.get(routeParam) : null;
      const pathname = routed !== null ? '/' + routed.replace(/^\/+/, '') : url.pathname;
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') return await handleApi(req, res, parts.slice(1), url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      if (pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
      if (pathname !== '/' && pathname !== '/index.html') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      if (!auth.isSignedIn(req)) return send(res, 200, auth.loginPage(), 'text/html; charset=utf-8');
      return send(res, 200, wrapPage(fs.readFileSync(PAGE, 'utf8')), 'text/html; charset=utf-8'); // read each time so page edits show on refresh
    } catch (e) {
      console.error(e);
      send(res, 500, { error: 'Server error' });
    }
  }

  return { handle, prepare, runSync };
}

module.exports = { createApp };
