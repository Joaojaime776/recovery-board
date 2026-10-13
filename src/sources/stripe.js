// Stripe Invoices API (read-only). https://docs.stripe.com/api/invoices/list
const API = 'https://api.stripe.com/v1/invoices';

async function fetchStatus(key, status, since) {
  const out = [];
  let startingAfter;
  do {
    const qs = new URLSearchParams({ limit: '100', status, 'created[gte]': String(since) });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const res = await fetch(`${API}?${qs}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    out.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1).id : null;
  } while (startingAfter);
  return out;
}

module.exports = {
  id: 'stripe',
  label: 'Stripe',
  enabled: () => Boolean(process.env.STRIPE_SECRET_KEY),
  async fetchInvoices() {
    const key = process.env.STRIPE_SECRET_KEY;
    const since = Math.floor(Date.now() / 1000) - 365 * 86400;
    const all = [...await fetchStatus(key, 'open', since), ...await fetchStatus(key, 'paid', since)];
    return all.map(i => {
      const paidAt = i.status_transitions?.paid_at;
      return {
        id: `stripe:${i.id}`,
        number: i.number || i.id,
        client: i.customer_name || i.customer_email || i.customer,
        clientEmail: i.customer_email || null,
        amount: i.amount_due / 100,
        amountPaid: i.amount_paid / 100,
        currency: i.currency.toUpperCase(),
        issuedAt: new Date(i.created * 1000).toISOString(),
        // Invoices charged automatically have no due_date; treat the issue date as due.
        dueDate: new Date((i.due_date || i.created) * 1000).toISOString(),
        paidAt: paidAt ? new Date(paidAt * 1000).toISOString() : null,
        source: 'stripe',
        sourceLabel: 'Stripe',
        gatewayStatus: i.status,
      };
    });
  },
};
