// The "Opportunity to Bid on <Name>'s Accounts & Leads" email.
//
// - Leads and corporates counts come from HR's "CSM Resignation - Leads & Corporates Data - <Name>"
//   email in the mailbox: the Leads_<code>.xlsx / Corporates_<code>.xlsx attachments are counted
//   (rows only, nothing from them is stored). The newest HR email for that code wins.
// - DOJ comes from PMS. Active leads (as per AI) are typed in.
// - Recipients: everyone in PMS's Sales team who has not resigned, in BCC; To is the mailbox itself.
// - Sent from OUTLOOK_MAILBOX through Microsoft Graph (Mail.Send).
const outlook = require('./outlook');
const { readSheet } = require('./xlsx');

const LEADS_NAME = 'leads-data.json';
const LEADS_SUBJECT = /^\s*CSM Resignation\s*-\s*Leads\s*&\s*Corporates Data\s*-\s*(.+?)\s*$/i;
const LEADS_FRESH_MS = 30 * 60 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const firstName = name => (String(name || '').trim().split(/\s+/)[0] || '').replace(/[^\p{L}\p{N}'-]/gu, '') || String(name || '').trim();
const mailboxUrl = () => `${outlook.GRAPH}/users/${encodeURIComponent(outlook.mailbox())}`;

// rows in a sheet after the header that have something in them
const countRows = buf => readSheet(buf).slice(1).filter(r => r.some(v => v != null && String(v).trim() !== '')).length;

async function download(messageId, attachmentId) {
  const j = await outlook.graphGet(`${mailboxUrl()}/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(j.contentBytes || '', 'base64');
}

// Finds the newest HR leads email for this employee and counts its spreadsheets.
async function lookupLeads({ code, name, since }) {
  const from = new Date((since || Date.now()) - 60 * 864e5).toISOString().slice(0, 10);
  let url = `${mailboxUrl()}/messages?$search=${encodeURIComponent(`"subject:Corporates AND received>=${from}"`)}&$select=id,subject,receivedDateTime,hasAttachments,webLink&$top=100`;
  const found = [];
  while (url && found.length < 275) { const j = await outlook.graphGet(url); found.push(...(j.value || [])); url = j['@odata.nextLink']; }
  const candidates = found.filter(m => m.hasAttachments && LEADS_SUBJECT.test(m.subject || '')).sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
  const want = (kind, n) => new RegExp(`^${kind}_${code}\\.xlsx$`, 'i').test(n);
  // first choice: attachments named with the employee code; else the subject names the person
  const byName = m => norm(m.subject.match(LEADS_SUBJECT)[1]) === norm(name);
  for (const pass of ['code', 'name']) {
    for (const m of candidates) {
      if (pass === 'name' && !byName(m)) continue;
      const att = (await outlook.graphGet(`${mailboxUrl()}/messages/${m.id}/attachments?$select=id,name,isInline`)).value || [];
      const leads = att.find(a => !a.isInline && (pass === 'code' ? want('Leads', a.name) : /^Leads_.*\.xlsx$/i.test(a.name)));
      if (!leads) continue;
      const corps = att.find(a => !a.isInline && (pass === 'code' ? want('Corporates', a.name) : /^Corporates_.*\.xlsx$/i.test(a.name)));
      return {
        leads: countRows(await download(m.id, leads.id)),
        corporates: corps ? countRows(await download(m.id, corps.id)) : 0,
        corporatesFile: !!corps, subject: m.subject, receivedAt: Date.parse(m.receivedDateTime), link: m.webLink, checkedAt: Date.now()
      };
    }
  }
  return null;
}

// Counts for each case, cached in storage (looked up again after 30 minutes or on refresh).
async function leadsFor({ storage, cases, refresh = false }) {
  const saved = (storage && await storage.readJson(LEADS_NAME).catch(() => null)) || {};
  const out = {};
  let changed = false;
  for (const c of cases) {
    const code = String(c.outgoing.emp || '');
    const hit = saved[code];
    if (!refresh && hit && Date.now() - hit.checkedAt < LEADS_FRESH_MS) { out[c.id] = hit.leads != null ? hit : null; continue; }
    const r = await lookupLeads({ code, name: c.outgoing.name, since: c.resignDate });
    saved[code] = r || { leads: null, checkedAt: Date.now() };
    changed = true;
    out[c.id] = r;
  }
  if (changed && storage) await storage.writeJson(LEADS_NAME, saved);
  return out;
}

// Everyone in Sales who has not resigned, plus extra addresses, minus left-out ones.
function recipients(employees, { extra = [], exclude = [] } = {}) {
  const ex = new Set(exclude.map(e => e.toLowerCase()));
  const list = new Map();
  for (const e of employees) {
    if ((e.department || '').toLowerCase() !== 'sales' || e.resignationDate || !e.email) continue;
    list.set(e.email.toLowerCase(), { name: e.name || e.email, email: e.email.toLowerCase() });
  }
  for (const a of extra) { const k = a.toLowerCase(); if (!list.has(k)) list.set(k, { name: (employees.find(e => (e.email || '').toLowerCase() === k) || {}).name || k, email: k }); }
  return [...list.values()].filter(r => !ex.has(r.email) && r.email !== outlook.mailbox().toLowerCase()).sort((a, b) => a.name.localeCompare(b.name));
}

// PMS dates look like "2025-10-10T00:00:00" (no time zone), so read the date part as written
const fmtDoj = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${MON[+m[2] - 1]}-${m[1].slice(-2)}` : '—'; };
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const quarterOf = ymd => { const [y, m] = ymd.split('-').map(Number); return `Q${Math.floor((m - 1) / 3) + 1}'${String(y).slice(-2)}`; };
const andList = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1);

// rows: [{ name, doj, leads, corporates, active }]; deadline: 'YYYY-MM-DD'
function buildEmail({ rows, pollUrl, deadline, senderName }) {
  const firsts = rows.map(r => firstName(r.name));
  const many = rows.length > 1;
  const subject = `Opportunity to Bid on ${many ? firsts.slice(0, -1).map(f => f + "'s").join(', ') + ' & ' + firsts.at(-1) + "'s" : firsts[0] + "'s"} Accounts & Leads`;
  const q = quarterOf(istToday());
  const [dy, dm, dd] = deadline.split('-').map(Number);
  const tomorrow = new Date(Date.parse(istToday()) + 864e5).toISOString().slice(0, 10);
  const by = `${deadline === tomorrow ? 'tomorrow, ' : ''}${ordinal(dd)} ${MONTH[dm - 1]} ${dy}`;
  const poll = `<a href="${esc(pollUrl)}">Poll</a>`;
  const td = 'border:1px solid #000;padding:2px 6px;text-align:center';
  const th = td + ';background:#BDE3F2;font-weight:bold';
  const table = `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt">
<tr><th style="${th}">CSM Name</th><th style="${th}">DOJ</th><th style="${th}">Total Leads</th><th style="${th}">Corporate Leads</th><th style="${th}">Active Leads (as per AI)</th></tr>
${rows.map(r => `<tr><td style="${td}">${esc(r.name)}</td><td style="${td}">${esc(r.doj)}</td><td style="${td}">${esc(r.leads ?? '')}</td><td style="${td}">${esc(r.corporates ?? '')}</td><td style="${td}">${esc(r.active ?? '')}</td></tr>`).join('\n')}
</table>`;
  const p = s => `<p style="margin:0 0 12px">${s}</p>`;
  const ul = items => `<ul style="margin:0 0 12px">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000">
${p('Dear CSM,')}
${p(many ? `<b>Established, high-potential portfolios</b> are now open for takeover following the exits of ${esc(andList(firsts))}.` : `An <b>established, high-potential portfolio</b> is now open for takeover following the exit of ${esc(firsts[0])}.`)}
${p(`This is an opportunity to take over an <b>established client portfolio with active business opportunities</b>, giving you a head start to accelerate your <b>${q} True NR and maximize your PLI potential</b>.`)}
${table}
<p style="margin:12px 0">This is a <b>time-bound growth opportunity</b> for ${q}.</p>
${p('<b>Portfolio Overview:</b>')}
${ul(['<b>Qualified Leads</b>', '<b>Regular Corporates</b>', '<b>Active Accounts</b>', 'Potential Relationships since <b>(DOJ)</b>', 'Live pipeline'])}
${p('This portfolio offers immediate leverage to:')}
${ul([`Accelerate <b>${q} NR</b>`, 'Expand your recurring corporate base', 'Improve your CSM Index positioning', 'Strengthen your visibility for upcoming growth cycles'])}
${p('A high bid may improve your chances of allocation and help you move towards the <b>8% PLI bracket</b>.')}
${p('<b>Example:</b> If you bid INR 10 lakh and generate INR 8 lakh additional True NR while being eligible for 8% PLI, it may add INR 64,000 to your PLI. PLI will be calculated on the actual True NR achieved, not on the bid amount.')}
${p(`We invite you to submit your bid for ${q} reflecting the value you are confident of unlocking from this data.`)}
${p(`<b>Note:</b> If you have informally taken over any lead or corporate account, kindly respond on the ${poll} accordingly`)}
${p('<b>*No Minimum Bid</b>')}
${p('<b>Please note:</b>')}
${ul(['Allocation will be finalized based on <b>highest competitive bid + Index strength</b>', 'Only serious bids demonstrating growth intent will be considered', 'Once allocated, the opportunity will not reopen'])}
${p(`We invite you to submit your bid for ${q} reflecting the value you are confident of unlocking from this data.`)}
${p(`<b>Kindly submit your bid via the ${poll} by ${esc(by)}</b>`)}
${p('If you are ready to scale faster this quarter, this is your window.')}
${p('Please note that as per the new policy <b>ASMs will no longer be eligible to bid on CSM takeover opportunities.</b>')}
<p style="margin:0">Best Regards,<br>${esc(senderName)}</p>
<p style="margin:12px 0 0">For urgent queries reach out to Ask-HR!</p>
</div>`;
  return { subject, html };
}

async function sendMail({ subject, html, bcc }) {
  const me = outlook.mailbox();
  const body = {
    message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: me } }], bccRecipients: bcc.map(address => ({ emailAddress: { address } })) },
    saveToSentItems: true
  };
  const r = await fetch(`${mailboxUrl()}/sendMail`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + await outlook.getToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`Outlook did not send the email (${r.status} ${j.error ? j.error.code + ': ' + j.error.message : ''})`); }
}

module.exports = { leadsFor, recipients, buildEmail, sendMail, fmtDoj, istToday };
