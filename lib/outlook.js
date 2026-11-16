// Collates takeover and opportunity emails from ONE Outlook mailbox (OUTLOOK_MAILBOX)
// through Microsoft Graph, using the app registration in GRAPH_* settings.
//
// Only subject lines, senders/recipients' names and addresses, dates and Outlook links
// are kept; message bodies are never downloaded. The app could read every mailbox in the
// tenant, so the mailbox is fixed in settings and nothing else is ever queried.
//
// Microsoft's mail search returns at most 275 results per query, so mail is searched in
// date windows, and any window that hits the limit is split in half until it does not.
// Progress is saved (outlook-emails.json in the app's storage): new mail is fetched on
// each sync, and older history is filled in a little at a time, newest first.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SEARCH_CAP = 275;
const HISTORY_START = Date.UTC(2018, 0, 1); // oldest mail looked at
const STATE_NAME = 'outlook-emails.json';
const CATEGORIES = [
  { key: 'takeover', label: 'Takeover', word: 'takeover', test: /takeover/i },
  { key: 'opportunity', label: 'Opportunity', word: 'opportunity', test: /opportunit/i }
];

const cfg = () => ({
  tenant: process.env.GRAPH_TENANT_ID,
  clientId: process.env.GRAPH_CLIENT_ID,
  secret: process.env.GRAPH_CLIENT_SECRET,
  mailbox: (process.env.OUTLOOK_MAILBOX || '').trim()
});
const configured = () => { const c = cfg(); return !!(c.tenant && c.clientId && c.secret && c.mailbox); };

let token = null; // { value, exp }
async function getToken() {
  if (token && Date.now() < token.exp - 60000) return token.value;
  const c = cfg();
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Outlook sign-in failed (${j.error || r.status}). Check the GRAPH_* settings and that the client secret has not expired.`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function graphGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + await getToken() }, signal: AbortSignal.timeout(30000) });
    if (r.status === 401) { token = null; continue; }
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1) * (+r.headers.get('retry-after') || 2))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Outlook request failed (${r.status} ${j.error ? j.error.code : ''})`);
    return j;
  }
  throw new Error('Outlook is busy or unavailable. Try again in a minute.');
}

const day = t => new Date(t).toISOString().slice(0, 10);
const person = r => r && r.emailAddress ? { name: r.emailAddress.name || '', email: (r.emailAddress.address || '').toLowerCase() } : null;

// All messages with `word` in the subject received in [from, to), splitting at the cap.
async function searchWindow(word, from, to, out) {
  const q = `subject:${word} AND received>=${day(from)} AND received<${day(to)}`;
  const select = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,conversationId,webLink,hasAttachments,isDraft';
  let url = `${GRAPH}/users/${encodeURIComponent(cfg().mailbox)}/messages?$search=${encodeURIComponent(`"${q}"`)}&$select=${select}&$top=100`;
  const found = [];
  while (url) { const j = await graphGet(url); found.push(...(j.value || [])); url = j['@odata.nextLink']; }
  const spanDays = Math.round((to - from) / 864e5);
  if (found.length >= SEARCH_CAP && spanDays > 1) {
    const mid = from + Math.floor(spanDays / 2) * 864e5;
    await searchWindow(word, from, mid, out);
    await searchWindow(word, mid, to, out);
    return;
  }
  for (const m of found) {
    if (m.isDraft) continue;
    out.set(m.id, {
      id: m.id, subject: m.subject || '(no subject)', at: Date.parse(m.receivedDateTime), conv: m.conversationId,
      from: person(m.from), to: (m.toRecipients || []).map(person).filter(Boolean), cc: (m.ccRecipients || []).map(person).filter(Boolean),
      link: m.webLink, att: !!m.hasAttachments,
      cats: CATEGORIES.filter(c => c.test.test(m.subject || '')).map(c => c.key)
    });
  }
}

async function fetchRange(from, to, messages) {
  const found = new Map();
  for (const c of CATEGORIES) await searchWindow(c.word, from, to, found);
  for (const [id, m] of found) if (m.cats.length) messages[id] = m; // keep only real subject matches
}

// Brings saved state up to date within `budgetMs`. Returns the state.
async function sync({ storage, budgetMs = Infinity } = {}) {
  const stopAt = Date.now() + budgetMs;
  const mailbox = cfg().mailbox.toLowerCase();
  let state = (storage && await storage.readJson(STATE_NAME).catch(() => null)) || null;
  if (!state || state.mailbox !== mailbox) state = { mailbox, messages: {}, newestSynced: null, backfillBefore: null, historyDone: false };
  const now = Date.now();
  const tomorrow = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);

  // 1) new mail since the last sync (overlapping two days, so nothing on the edge is missed)
  const from = state.newestSynced ? state.newestSynced - 2 * 864e5 : tomorrow - 31 * 864e5;
  await fetchRange(from, tomorrow, state.messages);
  state.newestSynced = now;
  if (!state.backfillBefore) state.backfillBefore = from;

  // 2) older history, one month at a time, while time allows
  while (!state.historyDone && Date.now() < stopAt) {
    const before = state.backfillBefore;
    const d = new Date(before);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCDate() === 1 ? 1 : 0), 1);
    const start = Math.max(monthStart, HISTORY_START);
    await fetchRange(start, before, state.messages);
    state.backfillBefore = start;
    if (start <= HISTORY_START) state.historyDone = true;
    if (storage) await storage.writeJson(STATE_NAME, state); // save progress after each month
  }
  state.syncedAt = now;
  if (storage) await storage.writeJson(STATE_NAME, state);
  return state;
}

// Groups messages into threads for the dashboard.
const cleanSubject = s => (s || '').replace(/^\s*((re|fw|fwd)\s*:\s*|\[[^\]]*\]\s*)+/i, '').trim() || '(no subject)';
function threads(state) {
  const by = new Map();
  for (const m of Object.values(state.messages || {})) {
    let t = by.get(m.conv);
    if (!t) by.set(m.conv, t = { id: m.conv, subject: cleanSubject(m.subject), cats: new Set(), count: 0, first: m.at, last: m.at, people: new Map(), attachments: false, link: m.link, lastFrom: m.from });
    t.count++;
    m.cats.forEach(c => t.cats.add(c));
    if (m.at < t.first) t.first = m.at;
    if (m.at >= t.last) { t.last = m.at; t.link = m.link; t.lastFrom = m.from; t.subject = cleanSubject(m.subject); }
    t.attachments = t.attachments || m.att;
    [m.from, ...m.to, ...m.cc].filter(Boolean).forEach(p => { if (p.email && !t.people.has(p.email)) t.people.set(p.email, p.name || p.email); });
  }
  return [...by.values()]
    .map(t => ({ ...t, cats: [...t.cats], people: [...t.people.values()].slice(0, 12), peopleCount: t.people.size }))
    .sort((a, b) => b.last - a.last);
}

module.exports = { configured, sync, threads, CATEGORIES, mailbox: () => cfg().mailbox, graphGet, getToken, GRAPH };
