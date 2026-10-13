// Demo source: fictional clients spread across several gateways so the dashboard works
// before any real account is connected. Each sync settles some invoices and issues new ones,
// seeded by the date so repeated syncs on the same day give the same result.
const store = require('../store');

const DAY = 86400000;
const CLIENTS = [
  'Northwind Studio', 'Lumen & Co', 'Bright Harbor Media', 'Pixel Orchard', 'Copperleaf Labs',
  'Atlas Kitchen Group', 'Bluefin Analytics', 'Maple Street Dental', 'Kite & Key Agency',
  'Solstice Yoga', 'Redwood Legal', 'Nimbus Robotics', 'Fernway Travel', 'Quarry Coffee Roasters',
];
const GATEWAYS = ['Stripe', 'PayPal', 'Bank transfer', 'Asaas'];

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function makeInvoice(n, issued, rand) {
  const client = CLIENTS[Math.floor(rand() * CLIENTS.length)];
  const gateway = GATEWAYS[Math.floor(rand() * GATEWAYS.length)];
  const terms = [7, 14, 30][Math.floor(rand() * 3)];
  const number = `INV-${String(n).padStart(4, '0')}`;
  return {
    id: `demo:${number}`,
    number,
    client,
    clientEmail: `billing@${client.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
    amount: Math.round((300 + rand() * 6200) / 25) * 25,
    amountPaid: 0,
    currency: 'USD',
    issuedAt: new Date(issued).toISOString(),
    dueDate: new Date(issued + terms * DAY).toISOString(),
    paidAt: null,
    source: 'demo',
    sourceLabel: `${gateway} (demo)`,
    gatewayStatus: 'open',
  };
}

const settle = (inv, paidOn) =>
  ({ ...inv, paidAt: new Date(paidOn).toISOString(), amountPaid: inv.amount, gatewayStatus: 'paid' });

function seed(now) {
  const rand = rng('seed');
  const invoices = [];
  for (let n = 1001; n <= 1056; n++) {
    let inv = makeInvoice(n, now - Math.floor(rand() * 120) * DAY, rand);
    const due = Date.parse(inv.dueDate);
    // Older invoices are more likely to have been paid already.
    if (due < now && rand() < (now - due > 45 * DAY ? 0.72 : 0.3)) {
      const paidOn = Math.min(now - DAY, due + Math.floor((rand() - 0.3) * 40) * DAY);
      inv = settle(inv, Math.max(Date.parse(inv.issuedAt) + DAY, paidOn));
    }
    invoices.push(inv);
  }
  return invoices;
}

module.exports = {
  id: 'demo',
  label: 'Demo gateways',
  enabled: () => process.env.DEMO_MODE === 'true' ||
    (process.env.DEMO_MODE !== 'false' && !process.env.STRIPE_SECRET_KEY && !process.env.ASAAS_API_KEY),
  async fetchInvoices() {
    const now = Date.now();
    const existing = store.getInvoices().filter(i => i.source === 'demo');
    if (!existing.length) return seed(now);

    const today = new Date(now).toISOString().slice(0, 10);
    const updated = existing.map(inv => {
      if (inv.paidAt) return inv;
      const late = Math.floor((now - Date.parse(inv.dueDate)) / DAY);
      // Reminders work best in the first weeks; long-overdue invoices rarely pay.
      const chance = late < 0 ? 0.03 : late <= 14 ? 0.12 : late <= 45 ? 0.07 : 0.025;
      return rng(today + inv.id)() < chance ? settle(inv, now) : inv;
    });
    // New invoices: at most once per day.
    if (!existing.some(i => i.issuedAt.slice(0, 10) === today && i.firstSeenAt?.slice(0, 10) === today)) {
      const rand = rng('new' + today);
      const last = Math.max(...existing.map(i => Number(i.number.slice(4))));
      const count = Math.floor(rand() * 3);
      for (let k = 1; k <= count; k++) updated.push(makeInvoice(last + k, now, rand));
    }
    return updated;
  },
};
