// Clients for the Koenig Kites APIs used by the dashboard:
//  - "Get Employee Details (PMS)"  (Employee Master)      settings KITES_*
//  - "Get Employee Code by Email"  (codes for each email)  settings KITES_CODE_*
// Credentials come from .env and stay on the server; only safe fields are passed on.
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const baseUrl = () => (process.env.KITES_BASE_URL || 'https://api.koenig-solutions.com').replace(/\/+$/, '');

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json };
}
const describe = res => `HTTP ${res.status}${res.json ? ', ' + (res.json.message || res.json.statuscode) : ''}`;

// One Kites API account: logs in for an access/device token and calls `common` with it.
function createClient(prefix, label) {
  const cfg = () => ({
    userName: process.env[prefix + 'USERNAME'],
    userPassword: process.env[prefix + 'PASSWORD'],
    userRole: process.env[prefix + 'ROLE'],
    apiKey: process.env[prefix + 'API_KEY']
  });
  let token = null;

  async function login() {
    const c = cfg();
    const res = await postJson(`${baseUrl()}/api/Kites/Operator/GetToken`, { userName: c.userName, userPassword: c.userPassword, userRole: c.userRole });
    const t = res.json && res.json.content;
    if (res.status !== 200 || !res.json || res.json.statuscode !== 200 || !t || !t.accessToken || !t.deviceToken) {
      throw new Error(`Login to the ${label} API failed (${describe(res)})`);
    }
    token = { accessToken: t.accessToken, deviceToken: t.deviceToken };
    return token;
  }

  // Returns the `content` rows. The API sends them as a JSON-encoded string, not an array.
  async function call(body) {
    const c = cfg();
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = token || await login();
      const url = `${baseUrl()}/api/Kites/Operator/common?apikey=${encodeURIComponent(c.apiKey)}&accessToken=${encodeURIComponent(t.accessToken)}&deviceToken=${encodeURIComponent(t.deviceToken)}`;
      const res = await postJson(url, body);
      let rows = res.json && res.json.content;
      if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch (e) { rows = null; } }
      if (rows === null && res.json && res.json.statuscode === 200) rows = [];
      if (res.status === 200 && res.json && res.json.statuscode === 200 && Array.isArray(rows)) return rows;
      token = null; // token may have expired: log in again once, then give up
      if (attempt === 1) throw new Error(`${label} API request failed (${describe(res)})`);
    }
  }

  const configured = () => { const c = cfg(); return !!(c.userName && c.userPassword && c.userRole && c.apiKey); };
  return { configured, login, call };
}

const details = createClient('KITES_', 'employee details');
const codes = createClient('KITES_CODE_', 'employee code');

const clean = v => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const emailKey = v => (clean(v) || '').toLowerCase();

// Only these fields leave the server. Bank, address, phone, UAN, salary and
// similar personal data in the raw rows are never sent to the browser.
function toSafeEmployee(r) {
  const name = [r.first_name, r.middle_name, r.last_name].map(clean).filter(Boolean).join(' ');
  return {
    code: clean(r.emp_code ?? r.employee_code ?? r.EmpCode),
    name: name || null,
    department: clean(r.deparment_name ?? r.department_name),
    designation: clean(r.designation_name),
    manager: clean(r.manager_name),
    email: clean(r.email_address),
    dateOfJoining: clean(r.date_of_joining),
    resignationDate: clean(r.date_of_resigantion ?? r.date_of_resignation),
    lastWorkingDay: clean(r.last_working_day)
  };
}

const fetchEmployeesRaw = (empCode = '') => details.call({ emp_code: empCode });
const fetchCodesRaw = (officialEmail = '') => codes.call({ OfficialEmail: officialEmail });

// Codes found so far are saved (employee-codes.json in the app's storage), so later
// loads only look up emails not seen before. Employee codes do not change.
// `storage` is lib/storage.js; without one, codes are kept in memory only.
const CODES_NAME = 'employee-codes.json';
let memCodes = new Map();
async function readCodeCache(storage) {
  if (!storage) return new Map(memCodes);
  try { return new Map(Object.entries((await storage.readJson(CODES_NAME)) || {})); } catch (e) { return new Map(memCodes); }
}
async function writeCodeCache(storage, map) {
  memCodes = new Map(map);
  if (storage) await storage.writeJson(CODES_NAME, Object.fromEntries(map));
}

// Map of lower-cased official email -> employee code. The API only answers one email
// at a time (a blank email returns a few rows with no email to match on), so each
// email not already saved is looked up, 5 at a time, until `budgetMs` runs out.
// Whatever is found is saved; the rest is picked up on the next load.
async function codesByEmail(emails, { storage, budgetMs = Infinity } = {}) {
  const map = await readCodeCache(storage);
  const todo = [...new Set(emails.map(emailKey).filter(k => k && !map.has(k)))];
  const stopAt = Date.now() + budgetMs;
  let failed = 0, tried = 0;
  for (let i = 0; i < todo.length && Date.now() < stopAt; i += 5) {
    const slice = todo.slice(i, i + 5);
    tried += slice.length;
    await Promise.all(slice.map(async e => {
      try {
        const rows = await fetchCodesRaw(e);
        const hit = rows.find(r => emailKey(r.OfficialEmail) === e) || (rows.length === 1 ? rows[0] : null);
        if (hit && clean(hit.EmpCode)) map.set(e, clean(hit.EmpCode));
      } catch (err) { failed++; }
    }));
  }
  if (tried) await writeCodeCache(storage, map);
  if (tried && failed === tried) throw new Error(`Every code lookup failed (${failed})`);
  return { map, pending: todo.length - tried };
}

// Sales employees are looked up first: their codes are what takeover cases need.
const salesFirst = list => [...list].sort((a, b) => ((b.department || '').toLowerCase() === 'sales') - ((a.department || '').toLowerCase() === 'sales'));

let cache = null; // { at, employees, codeError, codesPending }
const CACHE_MS = 10 * 60 * 1000;
async function getEmployees({ refresh = false, storage, budgetMs } = {}) {
  if (!refresh && cache && !cache.codesPending && Date.now() - cache.at < CACHE_MS) return cache;
  const employees = (!refresh && cache && Date.now() - cache.at < CACHE_MS)
    ? cache.employees.map(e => ({ ...e }))
    : (await fetchEmployeesRaw('')).map(toSafeEmployee);
  let codeError = null, codesPending = 0;
  if (codes.configured()) {
    try {
      const { map, pending } = await codesByEmail(salesFirst(employees).map(e => e.email), { storage, budgetMs });
      employees.forEach(e => { if (!e.code) e.code = map.get(emailKey(e.email)) || null; });
      codesPending = pending;
    } catch (e) { codeError = e.message; console.error('Employee code API:', e.message); }
  } else codeError = 'The employee code API is not set up (KITES_CODE_* settings).';
  cache = { at: cache && !refresh && Date.now() - cache.at < CACHE_MS ? cache.at : Date.now(), employees, codeError, codesPending };
  return cache;
}

module.exports = { configured: details.configured, codesConfigured: codes.configured, fetchEmployeesRaw, fetchCodesRaw, getEmployees };
