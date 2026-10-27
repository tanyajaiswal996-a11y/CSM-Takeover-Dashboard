// Vercel entry point. vercel.json sends every request here with the original path in ?p=.
// Data lives in a private Vercel Blob store; nothing works until DASHBOARD_PASSWORD is set.
const { createApp } = require('../lib/app');
const { blobStorage, blobConfigured } = require('../lib/storage');
const auth = require('../lib/auth');

let app = null;

module.exports = async (req, res) => {
  const fail = (msg) => {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(msg);
  };
  // fail closed: never serve employee data without the password set
  if (!auth.enabled()) return fail('The dashboard is not set up yet: add DASHBOARD_PASSWORD in Vercel (Settings > Environment Variables) and redeploy.');
  if (!blobConfigured()) return fail('The dashboard is not set up yet: connect a private Blob store to this project in Vercel (Storage) and redeploy.');
  app = app || createApp({
    storage: blobStorage(),
    secureCookies: true,
    routeParam: 'p',
    codeBudgetMs: 25000, // look up employee codes for at most 25 s per request; later requests continue
    cacheMs: 60000       // re-read stored cases at most once a minute per running instance (free plan: 10k reads/month)
  });
  return app.handle(req, res);
};
