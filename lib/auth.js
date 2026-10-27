// One shared password for the whole dashboard (DASHBOARD_PASSWORD).
// A correct password sets a signed, HttpOnly session cookie valid for 7 days.
// Changing the password signs everyone out, because the signing key is derived from it.
const crypto = require('crypto');

const COOKIE = 'ctd_session';
const MAX_AGE_S = 7 * 24 * 3600;

const password = () => process.env.DASHBOARD_PASSWORD || '';
const enabled = () => !!password();
const key = () => crypto.createHash('sha256').update('ctd-session:' + (process.env.SESSION_SECRET || '') + ':' + password()).digest();
const sign = v => crypto.createHmac('sha256', key()).update(v).digest('base64url');

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(p => p.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

function isSignedIn(req) {
  if (!enabled()) return true;
  const [exp, sig] = readCookie(req, COOKIE).split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  return sameText(sig, sign(exp));
}

function sessionCookie(secure) {
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}
const clearCookie = secure => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

const checkPassword = attempt => enabled() && sameText(attempt || '', password());

const loginPage = message => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in · CSM Takeover Dashboard</title>
<style>
:root{--bg:#F3F5F3;--surface:#fff;--ink:#16201C;--muted:#5C6964;--line:#D9DFDB;--accent:#1E5B4A;--accent-ink:#fff;--crit:#B3372B}
@media (prefers-color-scheme:dark){:root{--bg:#0F1412;--surface:#161C19;--ink:#E4EBE7;--muted:#93A29B;--line:#29332E;--accent:#6DC2A5;--accent-ink:#0F1412;--crit:#EE7B6D;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
form{width:min(360px,100%);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:28px;display:flex;flex-direction:column;gap:14px}
.mark{width:34px;height:34px;border-radius:8px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-weight:700}
h1{font-size:18px;margin:0}p{margin:0;color:var(--muted)}label{font-size:12px;font-weight:600;color:var(--muted)}
input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);font:inherit}
button{padding:9px 12px;border:0;border-radius:6px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--crit);font-size:13px;min-height:1em}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<form id="f"><div class="mark">CT</div><h1>CSM Takeover Dashboard</h1>
<p>This dashboard shows Koenig employee data. Enter the team password to continue.</p>
<div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required autofocus></div>
<button type="submit">Sign in</button><div class="err" id="err" role="alert">${message || ''}</div></form>
<script>
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('err'); err.textContent = '';
  const r = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: document.getElementById('pw').value})}).catch(() => null);
  if (r && r.ok) location.reload();
  else err.textContent = r && r.status === 401 ? 'That password is not right. Ask HR for the current one.' : 'Could not sign in. Check your connection and try again.';
});
</script></body></html>`;

module.exports = { enabled, isSignedIn, sessionCookie, clearCookie, checkPassword, loginPage };
