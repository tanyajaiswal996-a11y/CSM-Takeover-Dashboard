// Where the dashboard keeps its data:
//  - on your computer: JSON files in data/
//  - on Vercel: private files in a Vercel Blob store (the server's disk does not persist there)
// Both expose readJson(name) / writeJson(name, value).
const fs = require('fs');
const path = require('path');

function fileStorage(dir) {
  return {
    kind: 'file',
    async readJson(name) {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    async writeJson(name, value) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); // write then rename, so a crash never leaves half a file
      fs.renameSync(file + '.tmp', file);
    }
  };
}

function blobStorage(prefix = 'csm-takeover/') {
  const { put, get } = require('@vercel/blob'); // loaded only on Vercel, so the local server needs no install
  return {
    kind: 'blob',
    async readJson(name) {
      const res = await get(prefix + name, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200 || !res.stream) return null;
      return JSON.parse(await new Response(res.stream).text());
    },
    async writeJson(name, value) {
      await put(prefix + name, JSON.stringify(value), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60
      });
    }
  };
}

const onVercel = () => !!process.env.VERCEL;
const blobConfigured = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

module.exports = { fileStorage, blobStorage, onVercel, blobConfigured };
