// Pulls payment info from every enabled source and records the outcome.
const store = require('./store');
const SOURCES = [require('./sources/stripe'), require('./sources/asaas'), require('./sources/demo')];

let running = null;

function enabledSources() {
  return SOURCES.filter(s => s.enabled()).map(s => ({ id: s.id, label: s.label }));
}

async function doSync(trigger) {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const source of SOURCES.filter(s => s.enabled())) {
    try {
      const invoices = await source.fetchInvoices();
      const { added, total } = store.replaceSource(source.id, invoices);
      results.push({ source: source.label, ok: true, total, added });
    } catch (err) {
      // A failing source keeps its last-known invoices.
      results.push({ source: source.label, ok: false, error: err.message });
    }
  }
  const entry = {
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.length > 0 && results.every(r => r.ok),
    results,
  };
  store.recordSync(entry);
  console.log(`[sync] ${trigger}: ${results.map(r => `${r.source}=${r.ok ? r.total : 'ERROR ' + r.error}`).join(', ')}`);
  return entry;
}

// Concurrent callers share one in-flight sync.
function runSync(trigger = 'manual') {
  if (!running) running = doSync(trigger).finally(() => { running = null; });
  return running;
}

module.exports = { runSync, enabledSources, isRunning: () => Boolean(running) };
