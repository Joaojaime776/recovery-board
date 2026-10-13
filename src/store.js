// Tiny JSON-file store. Writes go to a temp file first so a crash never leaves a half-written db.
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const EMPTY = { invoices: [], syncs: [], lastSuccessfulSync: null };

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

module.exports = {
  getInvoices: () => load().invoices,
  getSyncs: () => load().syncs,
  getLastSuccessfulSync: () => load().lastSuccessfulSync,

  // Replace every invoice from `source` with the freshly fetched list, keeping local-only fields.
  replaceSource(source, fresh) {
    const db = load();
    const previous = new Map(db.invoices.filter(i => i.source === source).map(i => [i.id, i]));
    const merged = fresh.map(inv => ({ ...inv, firstSeenAt: previous.get(inv.id)?.firstSeenAt || new Date().toISOString() }));
    db.invoices = db.invoices.filter(i => i.source !== source).concat(merged);
    return { added: merged.filter(i => !previous.has(i.id)).length, total: merged.length };
  },

  recordSync(entry) {
    const db = load();
    db.syncs.unshift(entry);
    db.syncs = db.syncs.slice(0, 60);
    if (entry.ok) db.lastSuccessfulSync = entry.finishedAt;
    save();
  },
};
