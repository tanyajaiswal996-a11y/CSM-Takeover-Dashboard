// Builds the public demo site for Vercel: dist/index.html is the dashboard page
// wrapped in a full HTML document. It has no server, so it runs in its offline
// demo mode (sample cases, nothing saved, no PMS connection or employee data).
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, 'csm-takeover-dashboard.html'), 'utf8');
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<meta name="robots" content="noindex">'
  + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '</head><body>' + page + '</body></html>';

const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`Wrote dist/index.html (${Math.round(html.length / 1024)} KB)`);
