// Vercel build step. The dashboard itself is served by the function in api/index.js,
// behind the shared password, so the only static file is robots.txt. The page must
// never be copied in here: static files would be served without the password check.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('Wrote dist/robots.txt (the dashboard is served by api/index.js)');
