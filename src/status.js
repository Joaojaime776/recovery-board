// Classifies synced invoices into the 5 status zones and works out where each one sits in the
// automated collection workflow. Labels are translated in the browser; the server sends ids.
const { daysBetween, zoneForLate, timeframeFor, TIMEFRAMES, DAY } = require('../public/logic');

const ZONES = [
  { id: 'pending',   color: '#4f7cff' },
  { id: 'overdue',   color: '#e0a100' },
  { id: 'recovery',  color: '#f0643c' },
  { id: 'escalated', color: '#c23a7d' },
  { id: 'paid',      color: '#17a673' },
];

// Automated collection steps, by days relative to the due date.
const WORKFLOW = [
  { id: 'predue',   day: -3, channel: 'email' },
  { id: 'friendly', day: 1,  channel: 'email' },
  { id: 'second',   day: 7,  channel: 'email_sms' },
  { id: 'firm',     day: 15, channel: 'email' },
  { id: 'plan',     day: 30, channel: 'email_sms' },
  { id: 'final',    day: 46, channel: 'email_letter' },
  { id: 'agency',   day: 60, channel: 'agency' },
];

const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

function workflowFor(inv, today) {
  const due = startOfDay(inv.dueDate);
  const late = daysBetween(due, inv.paidAt || today);
  const steps = WORKFLOW.map(s => ({
    ...s,
    date: new Date(due.getTime() + s.day * DAY).toISOString().slice(0, 10),
    done: late >= s.day,
  }));
  const completed = steps.filter(s => s.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    current: completed ? steps[completed - 1] : null,
    next: inv.paidAt ? null : steps[completed] || null,
  };
}

function enrich(inv, today = new Date()) {
  const late = daysBetween(inv.dueDate, inv.paidAt || today);
  return {
    ...inv,
    daysOverdue: Math.max(0, late),
    daysUntilDue: inv.paidAt ? 0 : Math.max(0, -late),
    outstanding: inv.paidAt ? 0 : Math.max(0, inv.amount - (inv.amountPaid || 0)),
    zone: inv.paidAt ? 'paid' : zoneForLate(late),
    timeframe: timeframeFor(Boolean(inv.paidAt), late),
    workflow: workflowFor(inv, today),
  };
}

module.exports = { ZONES, TIMEFRAMES, WORKFLOW, enrich };
