// Pure date/status rules shared by the server (require) and the browser (window.Logic),
// so zone thresholds and alert rules live in exactly one place.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;

  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);

  // 'YYYY-MM-DD' at local noon, so the date never shifts a day across timezones.
  const parseLocalDate = s => new Date(`${s}T12:00:00`);
  const toLocalDate = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };

  // Which zone an unpaid item belongs in, by days past its due date.
  function zoneForLate(late) {
    if (late <= 0) return 'pending';
    if (late <= 14) return 'overdue';
    if (late <= 45) return 'recovery';
    return 'escalated';
  }

  const TIMEFRAMES = [
    { id: 'all' }, { id: 'notdue' },
    { id: 'd1_30', min: 1, max: 30 }, { id: 'd31_60', min: 31, max: 60 },
    { id: 'd61_90', min: 61, max: 90 }, { id: 'd90plus', min: 91, max: Infinity },
    { id: 'paid' },
  ];

  function timeframeFor(paid, late) {
    if (paid) return 'paid';
    if (late <= 0) return 'notdue';
    return TIMEFRAMES.find(t => t.min && late >= t.min && late <= t.max).id;
  }

  // A user-created block in the same shape as a synced invoice. Its zone is wherever the
  // user put it, not date-driven.
  function enrichBlock(b, today = new Date()) {
    const paidAt = b.zone === 'paid' ? b.paidAt : null;
    const late = daysBetween(parseLocalDate(b.dueDate), paidAt || today);
    return {
      id: `block:${b.id}`,
      blockId: b.id,
      manual: true,
      kind: b.kind,
      client: b.title,
      number: '',
      clientEmail: null,
      note: b.note || '',
      amount: b.amount,
      amountPaid: paidAt ? b.amount : 0,
      currency: b.currency,
      issuedAt: b.createdAt,
      dueDate: parseLocalDate(b.dueDate).toISOString(),
      paidAt,
      source: 'manual',
      sourceLabel: 'Manual',
      daysOverdue: Math.max(0, late),
      daysUntilDue: paidAt ? 0 : Math.max(0, -late),
      outstanding: paidAt ? 0 : b.amount,
      zone: b.zone,
      timeframe: timeframeFor(Boolean(paidAt), late),
      workflow: null,
    };
  }

  const SOON_DAYS = 3;

  // Billing alerts for unpaid blocks, most urgent first. A block whose column disagrees with
  // its due date also gets a suggestion of where it belongs.
  function blockAlerts(blocks) {
    const alerts = [];
    for (const b of blocks) {
      if (b.zone === 'paid') continue;
      const late = b.daysOverdue > 0 ? b.daysOverdue : -b.daysUntilDue;
      const expected = zoneForLate(late);
      const suggest = expected !== b.zone ? expected : null;
      let type = null;
      if (late > 0) type = 'overdue';
      else if (late === 0) type = 'today';
      else if (-late <= SOON_DAYS) type = 'soon';
      else if (suggest) type = 'mismatch';
      if (!type) continue;
      alerts.push({ type, level: type === 'mismatch' ? 'info' : type === 'soon' ? 'warn' : 'danger', block: b, days: Math.abs(late), suggest });
    }
    const rank = { danger: 0, warn: 1, info: 2 };
    return alerts.sort((a, b) => rank[a.level] - rank[b.level] || b.block.daysOverdue - a.block.daysOverdue || a.block.daysUntilDue - b.block.daysUntilDue);
  }

  // Message tone the automation uses at each workflow step.
  const STEP_TONE = { predue: 'friendly', friendly: 'friendly', second: 'friendly', firm: 'firm', plan: 'firm', final: 'final', agency: 'final' };

  return { DAY, daysBetween, parseLocalDate, toLocalDate, zoneForLate, TIMEFRAMES, timeframeFor, enrichBlock, blockAlerts, SOON_DAYS, STEP_TONE };
});
