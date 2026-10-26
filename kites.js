// Client for the Koenig Kites "Get Employee Details (PMS)" API (Employee Master).
// Credentials come from .env and stay on the server; only safe fields are passed on.
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const cfg = () => ({
  base: (process.env.KITES_BASE_URL || 'https://api.koenig-solutions.com').replace(/\/+$/, ''),
  userName: process.env.KITES_USERNAME,
  userPassword: process.env.KITES_PASSWORD,
  userRole: process.env.KITES_ROLE,
  apiKey: process.env.KITES_API_KEY
});
const configured = () => { const c = cfg(); return !!(c.userName && c.userPassword && c.userRole && c.apiKey); };

let token = null; // { accessToken, deviceToken }

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

async function getToken() {
  const c = cfg();
  const res = await postJson(`${c.base}/api/Kites/Operator/GetToken`, { userName: c.userName, userPassword: c.userPassword, userRole: c.userRole });
  const t = res.json && res.json.content;
  if (res.status !== 200 || !res.json || res.json.statuscode !== 200 || !t || !t.accessToken || !t.deviceToken) {
    throw new Error(`Login to the employee API failed (HTTP ${res.status}${res.json ? ', ' + (res.json.message || res.json.statuscode) : ''})`);
  }
  token = { accessToken: t.accessToken, deviceToken: t.deviceToken };
  return token;
}

// Raw employee rows. empCode '' returns everyone.
async function fetchEmployeesRaw(empCode = '') {
  const c = cfg();
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = token || await getToken();
    const url = `${c.base}/api/Kites/Operator/common?apikey=${encodeURIComponent(c.apiKey)}&accessToken=${encodeURIComponent(t.accessToken)}&deviceToken=${encodeURIComponent(t.deviceToken)}`;
    const res = await postJson(url, { emp_code: empCode });
    // the API sends `content` as a JSON-encoded string, not an array
    let rows = res.json && res.json.content;
    if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch (e) { rows = null; } }
    if (res.status === 200 && res.json && res.json.statuscode === 200 && Array.isArray(rows)) return rows;
    token = null; // token may have expired: log in again once, then give up
    if (attempt === 1) throw new Error(`Employee API request failed (HTTP ${res.status}${res.json ? ', ' + (res.json.message || res.json.statuscode) : ''})`);
  }
}

// Only these fields leave the server. Bank, address, phone, UAN, salary and
// similar personal data in the raw rows are never sent to the browser.
const clean = v => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
function toSafeEmployee(r) {
  const name = [r.first_name, r.middle_name, r.last_name].map(clean).filter(Boolean).join(' ');
  return {
    // the API does not return an employee code today; pick it up if it is added under a usual name
    code: clean(r.emp_code ?? r.employee_code ?? r.EmpCode ?? r.emp_id ?? r.employee_id),
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

let cache = null; // { at, employees }
const CACHE_MS = 10 * 60 * 1000;
async function getEmployees({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const rows = await fetchEmployeesRaw('');
  cache = { at: Date.now(), employees: rows.map(toSafeEmployee) };
  return cache;
}

module.exports = { configured, getToken, fetchEmployeesRaw, getEmployees };
