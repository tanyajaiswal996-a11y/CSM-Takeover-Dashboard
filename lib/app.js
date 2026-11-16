// The dashboard's request handler, shared by the local server (server.js) and Vercel (api/index.js).
// Serves the page behind the shared password and the JSON API:
//   GET  /api/cases | /api/batches            list
//   PUT  /api/cases/<id>, DELETE /api/cases/<id>   (same for batches)
//   GET  /api/employees[?department=Sales][&refresh=1]
//   POST /api/sync                             create cases from PMS resignations
//   POST /api/access  (exchanges the share-link code for an access cookie)
//   GET  /api/emails[?refresh=1]   takeover/opportunity email threads from Outlook
//   GET  /api/bidmail?cases=<id,id>[&refresh=1]   data for the "Opportunity to Bid" email
//   POST /api/bidmail/preview | /api/bidmail/send   build it, or send it (test: true sends to the mailbox only)
//   GET  /demo        public demo with sample cases, no PMS data
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kites = require('../kites');
const outlook = require('./outlook');
const auth = require('./auth');
const bidmail = require('./bidmail');

const PAGE = path.join(__dirname, '..', 'csm-takeover-dashboard.html');
const DB_NAME = 'db.json';
const COLLECTIONS = ['cases', 'batches'];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 1024 * 1024;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const BATCH_WINDOW_MS = 3 * 864e5;

// The page has no <head> of its own (the claude.ai viewer adds one), so wrap it here.
const wrapPage = (html, privateLink) => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">'
  + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
  + `<script>window.CTD_AUTH=${privateLink ? 'true' : 'false'}</script>`
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

// requireAccess: only open with the private share link (on Vercel). Off on your own computer.
function createApp({ storage, secureCookies = false, routeParam = null, codeBudgetMs = Infinity, cacheMs = 0, requireAccess = false }) {
  const signedIn = req => !requireAccess || auth.isSignedIn(req);
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

  // ---- Outlook ----
  // Synced at most every 10 minutes (or on Refresh); one sync at a time.
  let mail = null, mailSyncing = null;
  const OUTLOOK_EVERY_MS = 10 * 60 * 1000;
  async function emailThreads({ refresh = false } = {}) {
    if (refresh || !mail || Date.now() - (mail.syncedAt || 0) > OUTLOOK_EVERY_MS || !mail.historyDone) {
      mailSyncing = mailSyncing || outlook.sync({ storage, budgetMs: codeBudgetMs }).finally(() => { mailSyncing = null; });
      mail = await mailSyncing;
    }
    return { mailbox: outlook.mailbox(), syncedAt: mail.syncedAt, historyDone: mail.historyDone, historyFrom: mail.backfillBefore,
      messages: Object.keys(mail.messages).length, categories: outlook.CATEGORIES.map(c => ({ key: c.key, label: c.label })), threads: outlook.threads(mail) };
  }

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

  // ---- "Opportunity to Bid" email ----
  const isUrl = v => { try { return new URL(v).protocol === 'https:'; } catch (e) { return false; } };
  const emailList = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const fail = (status, message) => Object.assign(new Error(message), { status });
  // "Opportunity to Bid on <first name>…" sent from the mailbox after the resignation
  async function sentByHand(cases) {
    const state = await storage.readJson('outlook-emails.json').catch(() => null);
    if (!state || !state.messages) return {};
    const me = outlook.mailbox().toLowerCase();
    const mine = Object.values(state.messages).filter(m => m.from && m.from.email === me && /^\s*Opportunity to Bid on/i.test(m.subject || ''));
    const out = {};
    for (const c of cases) {
      const first = String(c.outgoing.name || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (first.length < 3) continue;
      const hit = mine.filter(m => m.at >= (c.resignDate || 0) - 7 * 864e5 && new RegExp('\\b' + first + '\\b', 'i').test(m.subject)).sort((a, b) => a.at - b.at)[0];
      if (hit) out[c.id] = { at: hit.at, subject: hit.subject };
    }
    return out;
  }
  async function bidData(ids, refresh) {
    const db = await getDb({ fresh: true });
    const cases = ids.map(id => db.cases[id]).filter(Boolean);
    if (!cases.length || cases.length !== ids.length) throw fail(404, 'Case not found');
    const { employees: list } = await employees();
    const leads = await bidmail.leadsFor({ storage, cases, refresh });
    const byHand = await sentByHand(cases);
    const settings = db.meta.bidEmail || { extra: [], exclude: [] };
    const me = outlook.mailbox().toLowerCase();
    const sender = (list.find(e => (e.email || '').toLowerCase() === me) || {}).name || me.split('@')[0];
    return { cases, list, settings, sender, rows: cases.map(c => {
      const e = list.find(x => x.code === c.outgoing.emp) || {};
      const l = leads[c.id];
      return { caseId: c.id, name: c.outgoing.name, emp: c.outgoing.emp, doj: bidmail.fmtDoj(e.dateOfJoining), leads: l ? l.leads : null, corporates: l ? l.corporates : null, active: l ? l.active ?? null : null,
        source: l ? { subject: l.subject, receivedAt: l.receivedAt, link: l.link, corporatesFile: l.corporatesFile } : null, sentAt: c.bidEmail ? (c.bidEmail.sentAt || c.bidEmail.at) : null, outlookSent: byHand[c.id] || null };
    }) };
  }
  // the page's values (typed numbers, poll link, deadline) on top of the server's data
  function compose(d, body) {
    const pollUrl = String(body.pollUrl || '').trim();
    if (!isUrl(pollUrl)) throw fail(400, 'Paste the poll link (it starts with https://).');
    const deadline = String(body.deadline || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline < bidmail.istToday()) throw fail(400, 'Pick a bid deadline from today onwards.');
    const num = v => (v === '' || v == null || !isFinite(+v)) ? null : Math.max(0, Math.round(+v));
    const typed = Object.fromEntries((body.rows || []).map(r => [r.caseId, r]));
    const rows = d.rows.map(r => { const t = typed[r.caseId] || {}; return { ...r, leads: num(t.leads) ?? r.leads, corporates: num(t.corporates) ?? r.corporates, active: num(t.active) ?? r.active,
      futureSC: String(t.futureSC || '').split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => { const [id, ...rest] = l.split(/[\s,;|\t]+/); return { id, nr: rest.join(' ') }; }).filter(x => x.id).slice(0, 50) }; });
    const settings = { extra: emailList(body.extra ?? d.settings.extra), exclude: emailList(body.exclude ?? d.settings.exclude) };
    const recipients = bidmail.recipients(d.list, settings);
    const mail = bidmail.buildEmail({ rows, pollUrl, deadline, senderName: d.sender });
    return { pollUrl, deadline, rows, settings, recipients, ...mail };
  }
  async function handleBidMail(req, res, action, url) {
    if (!outlook.configured()) return send(res, 503, { error: 'Outlook is not set up. Add the GRAPH_* and OUTLOOK_MAILBOX settings.' });
    if (!kites.configured()) return send(res, 503, { error: 'The employee API is not set up.' });
    try {
      if (action === undefined && req.method === 'GET') {
        const ids = (url.searchParams.get('cases') || '').split(',').filter(id => ID_RE.test(id));
        const d = await bidData(ids, url.searchParams.get('refresh') === '1');
        return send(res, 200, { mailbox: outlook.mailbox(), sender: d.sender, rows: d.rows, extra: d.settings.extra, exclude: d.settings.exclude,
          recipients: bidmail.recipients(d.list, d.settings), today: bidmail.istToday() });
      }
      if (action === 'mark' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
        const ids = (body.caseIds || []).filter(id => ID_RE.test(id));
        const d = await bidData(ids, false);
        const rows = d.rows.filter(r => r.outlookSent && !r.sentAt);
        await change(db => rows.forEach(r => {
          const c = db.cases[r.caseId], at = r.outlookSent.at;
          c.bidEmail = { sentAt: at, subject: r.outlookSent.subject, byHand: true };
          if (c.stage === 0) { c.bid = { pollUrl: '', sentAt: at, openAt: at, closeAt: at + 24 * 3600e3, closedAt: null }; c.stage = 1; c.stageAt = { ...(c.stageAt || {}), 1: at }; }
          (c.log = c.log || []).push({ at: Date.now(), by: outlook.mailbox(), text: `Marked as sent: "${r.outlookSent.subject}" went out from Outlook on ${new Date(at).toISOString().slice(0, 10)}.` });
        }));
        return send(res, 200, { ok: true, marked: rows.length });
      }
      if ((action === 'preview' || action === 'send') && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
        const ids = (body.caseIds || []).filter(id => ID_RE.test(id));
        const d = await bidData(ids, false);
        const m = compose(d, body);
        if (action === 'preview') return send(res, 200, { subject: m.subject, html: m.html, recipients: m.recipients });
        if (body.test) { // only to the mailbox itself; the case is not changed
          await bidmail.sendMail({ subject: '[TEST] ' + m.subject, html: m.html, bcc: [] });
          return send(res, 200, { ok: true, test: true, to: outlook.mailbox() });
        }
        if (d.rows.some(r => r.sentAt)) throw fail(409, 'The bid email for this case was already sent.');
        const dup = d.rows.find(r => r.outlookSent);
        if (dup) throw fail(409, `${dup.name}'s bid email was already sent from Outlook ("${dup.outlookSent.subject}"). Untick that row.`);
        if (m.rows.some(r => r.leads == null || r.corporates == null)) throw fail(400, 'Fill in Total Leads and Corporate Leads first.');
        if (m.recipients.length < 5) throw fail(400, 'Too few recipients. Check the Sales list in PMS.');
        // mark the cases first, so a second click cannot send it twice
        const now = Date.now();
        const claimed = await change(db => {
          if (ids.some(id => db.cases[id] && db.cases[id].bidEmail)) return false;
          ids.forEach(id => { db.cases[id].bidEmail = { sending: true, at: now }; });
          return true;
        });
        if (!claimed) throw fail(409, 'The bid email for this case was already sent.');
        try { await bidmail.sendMail({ subject: m.subject, html: m.html, bcc: m.recipients.map(r => r.email) }); }
        catch (e) { await change(db => { ids.forEach(id => { if (db.cases[id]) delete db.cases[id].bidEmail; }); }); throw e; }
        const close = Date.parse(m.deadline + 'T23:59:00+05:30');
        await change(db => {
          db.meta.bidEmail = m.settings;
          ids.forEach(id => {
            const c = db.cases[id], r = m.rows.find(x => x.caseId === id);
            c.bidEmail = { sentAt: now, subject: m.subject, pollUrl: m.pollUrl, deadline: m.deadline, recipients: m.recipients.length, leads: r.leads, corporates: r.corporates, active: r.active };
            if (c.stage === 0) {
              c.bid = { pollUrl: m.pollUrl, sentAt: now, openAt: now, closeAt: close, closedAt: null };
              c.stage = 1; c.stageAt = { ...(c.stageAt || {}), 1: now };
            }
            c.comms = c.comms || []; c.log = c.log || [];
            c.comms.push({ id: 'm' + now.toString(36) + id.slice(-3), at: now, template: 'Opportunity to Bid (sent from Outlook)', subject: m.subject, to: `${m.recipients.length} Sales staff in BCC`, thread: 'Outlook', attachments: [] });
            c.log.push({ at: now, by: outlook.mailbox(), text: `Bid email sent from Outlook to ${m.recipients.length} people in BCC. Bids close ${m.deadline}.` });
          });
        });
        return send(res, 200, { ok: true, sent: m.recipients.length, subject: m.subject });
      }
      return send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (!e.status) console.error('Bid email:', e.message);
      return send(res, e.status || 502, { error: e.message });
    }
  }

  async function handleApi(req, res, parts, url) {
    const [col, rawId] = parts;
    if (col === 'access') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      let code = '';
      try { code = JSON.parse((await readBody(req)) || '{}').code || ''; } catch (e) {}
      if (!auth.checkCode(code)) { await sleep(800); return send(res, 401, { error: 'This link is not valid' }); } // slow down guessing
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.sessionCookie(secureCookies) });
    }
    if (!signedIn(req)) return send(res, 401, { error: 'Open the dashboard with the shared link' });

    if (col === 'employees' && rawId === undefined) return handleEmployees(req, res, url);
    if (col === 'emails' && rawId === undefined) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      if (!outlook.configured()) return send(res, 503, { error: 'Outlook is not set up. Add the GRAPH_* and OUTLOOK_MAILBOX settings.' });
      try { return send(res, 200, await emailThreads({ refresh: url.searchParams.get('refresh') === '1' })); }
      catch (e) { console.error('Outlook:', e.message); return send(res, 502, { error: 'Could not load emails from Outlook. ' + e.message }); }
    }
    if (col === 'bidmail') return handleBidMail(req, res, rawId, url);
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
      // bidEmail is set only by the server when the email goes out; an older copy from a page must not erase it
      await change(db => { const old = db[col][id]; if (col === 'cases' && old && old.bidEmail) doc.bidEmail = old.bidEmail; db[col][id] = doc; });
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
      // public demo: sample cases only. The page runs offline there (its API calls are refused
      // without access), so no PMS or employee data is ever loaded on this route.
      if (pathname === '/demo' || pathname === '/demo/') return send(res, 200, wrapPage(fs.readFileSync(PAGE, 'utf8'), false), 'text/html; charset=utf-8');
      if (pathname !== '/' && pathname !== '/index.html') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      if (!signedIn(req)) return send(res, 403, auth.privatePage(), 'text/html; charset=utf-8');
      return send(res, 200, wrapPage(fs.readFileSync(PAGE, 'utf8'), requireAccess), 'text/html; charset=utf-8'); // read each time so page edits show on refresh
    } catch (e) {
      console.error(e);
      send(res, 500, { error: 'Server error' });
    }
  }

  return { handle, prepare, runSync };
}

module.exports = { createApp };
