// Asaas Payments API (read-only). https://docs.asaas.com/reference/list-payments
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const SKIP = new Set(['REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);

async function get(path) {
  const base = (process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3').replace(/\/$/, '');
  const res = await fetch(base + path, {
    headers: { access_token: process.env.ASAAS_API_KEY, 'User-Agent': 'debt-recovery-dashboard' },
  });
  if (!res.ok) throw new Error(`Asaas ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = {
  id: 'asaas',
  label: 'Asaas',
  enabled: () => Boolean(process.env.ASAAS_API_KEY),
  async fetchInvoices() {
    const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const payments = [];
    for (let offset = 0; ; offset += 100) {
      const page = await get(`/payments?limit=100&offset=${offset}&dateCreated[ge]=${since}`);
      payments.push(...page.data);
      if (!page.hasMore) break;
    }
    const customers = new Map();
    for (const id of new Set(payments.map(p => p.customer))) {
      try { const c = await get(`/customers/${id}`); customers.set(id, { name: c.name, email: c.email }); }
      catch { customers.set(id, { name: id, email: null }); }
    }
    return payments.filter(p => !SKIP.has(p.status) && !p.deleted).map(p => {
      const paid = PAID.has(p.status);
      const paidOn = p.clientPaymentDate || p.paymentDate || p.confirmedDate;
      return {
        id: `asaas:${p.id}`,
        number: p.invoiceNumber || p.id,
        client: customers.get(p.customer).name,
        clientEmail: customers.get(p.customer).email,
        amount: p.value,
        amountPaid: paid ? p.value : 0,
        currency: 'BRL',
        issuedAt: new Date(p.dateCreated + 'T12:00:00').toISOString(),
        dueDate: new Date(p.dueDate + 'T12:00:00').toISOString(),
        paidAt: paid && paidOn ? new Date(paidOn + 'T12:00:00').toISOString() : null,
        source: 'asaas',
        sourceLabel: 'Asaas',
        gatewayStatus: p.status,
      };
    });
  },
};
