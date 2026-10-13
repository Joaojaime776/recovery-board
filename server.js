const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env is optional */ }

const express = require('express');
const cron = require('node-cron');
const store = require('./src/store');
const { runSync, enabledSources, isRunning } = require('./src/sync');
const { ZONES, TIMEFRAMES, enrich } = require('./src/status');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SYNC_CRON = process.env.SYNC_CRON || '0 6 * * *';
// Public demo: visitors can press "Sync now", but at most once a minute.
const MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard', (req, res) => {
  const today = new Date();
  const invoices = store.getInvoices()
    .map(inv => enrich(inv, today))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || Date.parse(a.dueDate) - Date.parse(b.dueDate));
  res.json({
    generatedAt: today.toISOString(),
    zones: ZONES,
    timeframes: TIMEFRAMES.map(t => ({ id: t.id })),
    sources: enabledSources(),
    schedule: SYNC_CRON,
    syncing: isRunning(),
    lastSuccessfulSync: store.getLastSuccessfulSync(),
    lastSync: store.getSyncs()[0] || null,
    repoUrl: process.env.REPO_URL || null,
    invoices,
  });
});

app.post('/api/sync', async (req, res) => {
  const last = store.getSyncs()[0];
  if (last && Date.now() - Date.parse(last.finishedAt) < MANUAL_SYNC_COOLDOWN_MS) return res.json(last);
  res.json(await runSync('manual'));
});

app.get('/healthz', (req, res) => res.send('ok'));

if (!cron.validate(SYNC_CRON)) throw new Error(`Invalid SYNC_CRON "${SYNC_CRON}"`);
cron.schedule(SYNC_CRON, () => runSync('scheduled'), process.env.SYNC_TZ ? { timezone: process.env.SYNC_TZ } : {});

// Catch-up: if the server was off (or asleep on a free host) at the scheduled time, sync now,
// and re-check hourly so the data is never more than a day old.
function syncIfStale() {
  const last = store.getLastSuccessfulSync();
  if (!last || Date.now() - Date.parse(last) > 24 * 3600 * 1000) runSync(last ? 'catch-up' : 'initial');
}
syncIfStale();
setInterval(syncIfStale, 3600 * 1000);

app.listen(PORT, () => {
  console.log(`Debt recovery dashboard on http://localhost:${PORT}`);
  console.log(`Sources: ${enabledSources().map(s => s.label).join(', ') || 'none'} · daily sync "${SYNC_CRON}"`);
});
