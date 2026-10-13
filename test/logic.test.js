const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../public/logic');
const { enrich } = require('../src/status');

const TODAY = new Date('2026-10-13T12:00:00');
const daysFromToday = n => Logic.toLocalDate(TODAY.getTime() + n * Logic.DAY);
const iso = n => new Date(TODAY.getTime() + n * Logic.DAY).toISOString();

const block = (overrides = {}) => Logic.enrichBlock({
  id: 'b1', title: 'Rent', kind: 'payable', amount: 100, currency: 'BRL',
  dueDate: daysFromToday(0), zone: 'pending', note: '', createdAt: iso(-10), paidAt: null, ...overrides,
}, TODAY);

test('zoneForLate uses the 14 / 45 day thresholds', () => {
  assert.equal(Logic.zoneForLate(-5), 'pending');
  assert.equal(Logic.zoneForLate(0), 'pending');
  assert.equal(Logic.zoneForLate(1), 'overdue');
  assert.equal(Logic.zoneForLate(14), 'overdue');
  assert.equal(Logic.zoneForLate(15), 'recovery');
  assert.equal(Logic.zoneForLate(45), 'recovery');
  assert.equal(Logic.zoneForLate(46), 'escalated');
});

test('timeframeFor buckets days overdue', () => {
  assert.equal(Logic.timeframeFor(true, 50), 'paid');
  assert.equal(Logic.timeframeFor(false, 0), 'notdue');
  assert.equal(Logic.timeframeFor(false, 30), 'd1_30');
  assert.equal(Logic.timeframeFor(false, 31), 'd31_60');
  assert.equal(Logic.timeframeFor(false, 90), 'd61_90');
  assert.equal(Logic.timeframeFor(false, 91), 'd90plus');
});

test('enrich places a synced invoice in the zone matching its lateness', () => {
  const inv = { id: 'x', amount: 500, amountPaid: 0, dueDate: iso(-20), paidAt: null };
  const e = enrich(inv, TODAY);
  assert.equal(e.zone, 'recovery');
  assert.equal(e.daysOverdue, 20);
  assert.equal(e.workflow.current.id, 'firm');
  assert.equal(e.workflow.next.id, 'plan');
  assert.equal(enrich({ ...inv, paidAt: iso(-1) }, TODAY).zone, 'paid');
});

test('a block keeps the zone the user chose, whatever its date', () => {
  const b = block({ dueDate: daysFromToday(6), zone: 'overdue' });
  assert.equal(b.zone, 'overdue');
  assert.equal(b.daysUntilDue, 6);
  assert.equal(b.outstanding, 100);
});

test('a paid block has nothing outstanding', () => {
  const b = block({ zone: 'paid', paidAt: iso(0) });
  assert.equal(b.outstanding, 0);
  assert.equal(b.timeframe, 'paid');
});

test('blockAlerts flags overdue, due today and due soon, most urgent first', () => {
  const alerts = Logic.blockAlerts([
    block({ id: 'soon', dueDate: daysFromToday(2) }),
    block({ id: 'late', dueDate: daysFromToday(-3), zone: 'overdue' }),
    block({ id: 'today', dueDate: daysFromToday(0) }),
    block({ id: 'later', dueDate: daysFromToday(20) }),
    block({ id: 'paid', dueDate: daysFromToday(-3), zone: 'paid', paidAt: iso(0) }),
  ]);
  assert.deepEqual(alerts.map(a => [a.block.blockId, a.type]), [['late', 'overdue'], ['today', 'today'], ['soon', 'soon']]);
  assert.equal(alerts[0].days, 3);
  assert.equal(alerts[0].suggest, null);
});

test('blockAlerts suggests the right column when a block sits in the wrong one', () => {
  const [late] = Logic.blockAlerts([block({ dueDate: daysFromToday(-3), zone: 'pending' })]);
  assert.equal(late.type, 'overdue');
  assert.equal(late.suggest, 'overdue');

  const [early] = Logic.blockAlerts([block({ dueDate: daysFromToday(10), zone: 'overdue' })]);
  assert.equal(early.type, 'mismatch');
  assert.equal(early.level, 'info');
  assert.equal(early.suggest, 'pending');
});
