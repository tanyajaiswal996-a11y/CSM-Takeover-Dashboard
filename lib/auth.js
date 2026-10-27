// Private share link: no login screen and no password to type.
// The link looks like https://<site>/#access=<code>. The code sits after "#", so it is
// never sent in a URL or written to server logs; the page posts it once to /api/access,
// which sets a signed, HttpOnly cookie (30 days). Without the cookie nothing but a short
// "this dashboard is private" page is returned.
//
// The code is derived from the PMS API password already stored on the server, so nothing
// extra has to be set up. To change the link (for example if it leaked), set ACCESS_KEY to
// any new long random text and redeploy: the old link and every existing cookie stop working.
const crypto = require('crypto');

const COOKIE = 'ctd_access';
const MAX_AGE_S = 30 * 24 * 3600;

const secret = () => process.env.ACCESS_KEY || process.env.KITES_PASSWORD || '';
const enabled = () => !!secret();
const hmac = (label, v = '') => crypto.createHmac('sha256', 'ctd:' + secret()).update(label + ':' + v).digest('base64url');
// the code in the share link
const accessCode = () => hmac('share-link').slice(0, 32);

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
  return sameText(sig, hmac('session', exp));
}

function sessionCookie(secure) {
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  return `${COOKIE}=${exp}.${hmac('session', exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}
const clearCookie = secure => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

const checkCode = attempt => enabled() && sameText(attempt || '', accessCode());

// Shown to anyone without access. If the link carried a code, it is exchanged for the cookie.
const privatePage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>CSM Takeover Dashboard</title>
<style>
:root{--bg:#F3F5F3;--surface:#fff;--ink:#16201C;--muted:#5C6964;--line:#D9DFDB;--accent:#1E5B4A;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0F1412;--surface:#161C19;--ink:#E4EBE7;--muted:#93A29B;--line:#29332E;--accent:#6DC2A5;--accent-ink:#0F1412;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
main{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:28px;display:flex;flex-direction:column;gap:12px}
.mark{width:34px;height:34px;border-radius:8px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-weight:700}
h1{font-size:18px;margin:0}p{margin:0;color:var(--muted)}
</style></head><body>
<main><div class="mark">CT</div><h1>CSM Takeover Dashboard</h1>
<p id="msg">This dashboard is private. Open it with the link HR shared with you.</p></main>
<script>
(async () => {
  const m = location.hash.match(/access=([A-Za-z0-9_-]+)/);
  if (!m) return;
  const msg = document.getElementById('msg');
  msg.textContent = 'Opening the dashboard…';
  const r = await fetch('/api/access', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code: m[1]})}).catch(() => null);
  if (r && r.ok) { history.replaceState(null, '', location.pathname); location.reload(); }
  else msg.textContent = r && r.status === 401 ? 'This link is no longer valid. Ask HR for the current dashboard link.' : 'Could not open the dashboard. Check your connection and try again.';
})();
</script></body></html>`;

module.exports = { enabled, isSignedIn, sessionCookie, clearCookie, checkCode, accessCode, privatePage };
