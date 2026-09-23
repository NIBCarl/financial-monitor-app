/* Verification harness for the pure money/logic modules (compiled from src/utils). */
const assert = require('assert');
const path = require('path');

const validation = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'validation.js'));
const financial = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'financial.js'));
const reminderText = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'reminderText.js'));
const sealText = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'sealText.js'));

const { parseMoney, parsePositiveMoney, parseTermCount, parseInterestRate, round2, sanitizePhoneForUri } = validation;
const {
  calculateAmortization,
  allocatePayment,
  applyAllocationsToSchedules,
  getNextUnpaidSchedule,
  getDaysLate,
  isScheduleOverdue,
  getScheduleRemaining,
  parseDbTimestamp,
  formatDbDate,
  daysBetweenDates,
  localTodayString,
} = financial;
const { normalisePhone, buildReminderMessage, buildBulkReminderMessage } = reminderText;
const { buildSealPayload } = sealText;

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.log(`  FAIL  ${label} -> ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\n[1] parseMoney — the "10,000" bug (was: parseFloat -> 10)');
check('"10,000" -> 10000', () => assert.strictEqual(parseMoney('10,000').value, 10000));
check('"1,234.56" -> 1234.56', () => assert.strictEqual(parseMoney('1,234.56').value, 1234.56));
check('"  250  " -> 250', () => assert.strictEqual(parseMoney('  250  ').value, 250));
check('"1e5" rejected', () => assert.strictEqual(parseMoney('1e5').ok, false));
check('"12.345" rejected (3 decimals)', () => assert.strictEqual(parseMoney('12.345').ok, false));
check('"" rejected', () => assert.strictEqual(parseMoney('').ok, false));
check('"10,00" rejected (bad grouping)', () => assert.strictEqual(parseMoney('10,00').ok, false));
check('negative parses but parsePositiveMoney rejects; zero rejected', () => {
  assert.strictEqual(parseMoney('-500').value, -500);
  assert.strictEqual(parsePositiveMoney('-500').ok, false);
  assert.strictEqual(parsePositiveMoney('0').ok, false);
});
check('amount above MAX_MONEY rejected', () =>
  assert.strictEqual(parseMoney('10000000000').ok, false));

console.log('\n[2] Other input guards');
check('parseTermCount("0") rejected, ("4") ok, ("abc") rejected', () => {
  assert.strictEqual(parseTermCount('0').ok, false);
  assert.strictEqual(parseTermCount('4').value, 4);
  assert.strictEqual(parseTermCount('abc').ok, false);
});
check('parseInterestRate("150") rejected, ("2.5") ok', () => {
  assert.strictEqual(parseInterestRate('150').ok, false);
  assert.strictEqual(parseInterestRate('2.5').value, 2.5);
});
check('round2(1.005) === 1.01', () => assert.strictEqual(round2(1.005), 1.01));
check('sanitizePhoneForUri strips ";" and "#" but keeps "+"', () =>
  assert.strictEqual(sanitizePhoneForUri('+63 917;123#4'), '+639171234'));

console.log('\n[3] Amortization invariants (sum of installments === total payable)');
const flat = calculateAmortization({
  principal: 10000, interestRate: 5, interestType: 'FLAT', frequency: 'WEEKLY', termCount: 4, startDate: '2026-09-22',
});
const sumOf = (arr) => round2(arr.reduce((total, item) => total + item.expectedAmount, 0));

check('4 x weekly @5% flat: total 10500, 4 x 2625', () => {
  assert.strictEqual(flat.totalPayable, 10500);
  assert.strictEqual(flat.termCount, 4);
  assert.strictEqual(flat.installments.length, 4);
  assert.deepStrictEqual(flat.installments.map((i) => i.expectedAmount), [2625, 2625, 2625, 2625]);
});
check('rounding remainder lands on the final installment', () => {
  const calc = calculateAmortization({
    principal: 10000, interestRate: 0, interestType: 'NONE', frequency: 'MONTHLY', termCount: 3, startDate: '2026-09-22',
  });
  assert.strictEqual(sumOf(calc.installments), calc.totalPayable);
});
check('awkward amounts still balance exactly', () => {
  const calc = calculateAmortization({
    principal: 9999.99, interestRate: 3.75, interestType: 'FLAT', frequency: 'WEEKLY', termCount: 7, startDate: '2026-09-22',
  });
  assert.strictEqual(sumOf(calc.installments), calc.totalPayable);
});
check('LUMP_SUM collapses to ONE installment due next month (was: N identical dates)', () => {
  const calc = calculateAmortization({
    principal: 10000, interestRate: 5, interestType: 'FLAT', frequency: 'LUMP_SUM', termCount: 4, startDate: '2026-09-22',
  });
  assert.strictEqual(calc.termCount, 1);
  assert.strictEqual(calc.installments.length, 1);
  assert.strictEqual(calc.installments[0].dueDate, '2026-10-22');
  assert.strictEqual(calc.installments[0].expectedAmount, 10500);
});
check('term_count always equals the number of schedule rows', () =>
  assert.strictEqual(flat.termCount, flat.installments.length));

console.log('\n[4] FIFO payment allocation (was: only the tapped installment moved)');
const schedules = flat.installments.map((inst, index) => ({
  id: `sch_${index + 1}`,
  loanId: 'loan_1',
  installmentNumber: inst.installmentNumber,
  dueDate: inst.dueDate,
  expectedAmount: inst.expectedAmount,
  paidAmount: 0,
  status: 'PENDING',
  settledDate: null,
}));

const partial = allocatePayment(schedules, 5000);
check('5000 of 10500 -> #1 PAID 2625 + #2 PARTIAL 2375', () => {
  assert.strictEqual(partial.allocations.length, 2);
  assert.deepStrictEqual(partial.allocations[0], {
    scheduleId: 'sch_1', installmentNumber: 1, appliedAmount: 2625, newPaidAmount: 2625, newStatus: 'PAID',
  });
  assert.deepStrictEqual(partial.allocations[1], {
    scheduleId: 'sch_2', installmentNumber: 2, appliedAmount: 2375, newPaidAmount: 2375, newStatus: 'PARTIAL',
  });
  assert.strictEqual(partial.unallocated, 0);
});
check('no cash is lost or created by the waterfall', () => {
  const applied = round2(partial.allocations.reduce((total, a) => total + a.appliedAmount, 0));
  assert.strictEqual(round2(applied + partial.unallocated), 5000);
});
check('next due after the partial payment is installment #2 with 250 remaining', () => {
  const updated = applyAllocationsToSchedules(schedules, partial.allocations);
  const next = getNextUnpaidSchedule(updated);
  assert.strictEqual(next.installmentNumber, 2);
  assert.strictEqual(getScheduleRemaining(next), 250);
});
check('full settlement leaves no unpaid installment', () => {
  const full = allocatePayment(schedules, 10500);
  const updated = applyAllocationsToSchedules(schedules, full.allocations);
  assert.strictEqual(getNextUnpaidSchedule(updated), null);
  assert.strictEqual(full.unallocated, 0);
});
check('excess cash is reported, never dropped', () => {
  const excess = allocatePayment(schedules, 10600);
  assert.strictEqual(excess.unallocated, 100);
});

console.log('\n[5] Date handling (SQLite stores UTC with no zone marker)');
check('parseDbTimestamp reads "YYYY-MM-DD HH:MM:SS" as UTC', () =>
  assert.strictEqual(parseDbTimestamp('2026-09-21 23:30:00').getTime(), Date.parse('2026-09-21T23:30:00Z')));
check('ISO strings with Z are honoured', () =>
  assert.strictEqual(parseDbTimestamp('2026-09-21T23:30:00.000Z').getTime(), Date.parse('2026-09-21T23:30:00Z')));
check('formatDbDate returns a formatted date', () =>
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(formatDbDate('2026-09-21 23:30:00', 'yyyy-MM-dd'))));
check('overdue predicate + days late', () => {
  assert.strictEqual(isScheduleOverdue({ status: 'PENDING', dueDate: '2020-01-01' }), true);
  assert.strictEqual(isScheduleOverdue({ status: 'PENDING', dueDate: '2099-01-01' }), false);
  assert.strictEqual(isScheduleOverdue({ status: 'PAID', dueDate: '2020-01-01' }), false);
  assert.ok(getDaysLate('2020-01-01') > 2000);
  assert.strictEqual(getDaysLate('2099-01-01'), 0);
});

console.log('\n[6] Date buckets (aging schedule agrees with the UI pills)');
check('daysBetweenDates is signed and calendar-accurate', () => {
  assert.strictEqual(daysBetweenDates('2026-09-01', '2026-09-21'), 20);
  assert.strictEqual(daysBetweenDates('2026-09-21', '2026-09-21'), 0);
  assert.strictEqual(daysBetweenDates('2026-09-30', '2026-09-21'), -9);
});
check('daysBetweenDates crosses month and year boundaries', () => {
  assert.strictEqual(daysBetweenDates('2026-08-31', '2026-09-01'), 1);
  assert.strictEqual(daysBetweenDates('2025-12-31', '2026-01-01'), 1);
});
check('daysBetweenDates rejects malformed input rather than returning NaN', () => {
  assert.strictEqual(daysBetweenDates('not-a-date', '2026-09-21'), 0);
  assert.strictEqual(daysBetweenDates('2026-09-01', ''), 0);
});
check('localTodayString is zero-padded YYYY-MM-DD', () => {
  assert.strictEqual(localTodayString(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(localTodayString(new Date(2026, 11, 31)), '2026-12-31');
});

console.log('\n[7] Reminder text (phone normalisation + message templates)');
check('local PH numbers gain the 63 country code', () => {
  assert.strictEqual(normalisePhone('0917 123 4567'), '639171234567');
  assert.strictEqual(normalisePhone('9171234567'), '639171234567');
  assert.strictEqual(normalisePhone('+63 917 123 4567'), '639171234567');
  assert.strictEqual(normalisePhone('639171234567'), '639171234567');
});
check('empty phone normalises to empty (caller falls back to the share sheet)', () =>
  assert.strictEqual(normalisePhone(''), ''));
check('overdue message names the days late', () => {
  const msg = buildReminderMessage({
    borrowerName: 'Aling Nena',
    orgName: 'Barangay Treasury',
    amountDue: 875,
    dueDate: '2026-09-01',
    daysLate: 20,
    currencySymbol: 'PHP ',
  });
  assert.ok(msg.includes('Aling Nena'));
  assert.ok(msg.includes('20 days ago'));
  assert.ok(msg.includes('875.00'));
});
check('due-today message does not claim lateness', () => {
  const msg = buildReminderMessage({
    borrowerName: 'Mang Jose',
    orgName: 'Barangay Treasury',
    amountDue: 1000,
    dueDate: '2026-09-21',
    daysLate: 0,
    currencySymbol: 'PHP ',
  });
  assert.ok(msg.includes('due today'));
  assert.ok(!msg.includes('outstanding'));
});
check('upcoming message quotes the due date instead of a lateness count', () => {
  const msg = buildReminderMessage({
    borrowerName: 'Mang Jose',
    orgName: 'Barangay Treasury',
    amountDue: 1000,
    dueDate: '2026-09-25',
    daysLate: -4,
    currencySymbol: 'PHP ',
  });
  assert.ok(msg.includes('Sep 25, 2026'));
  assert.ok(!msg.includes('due today'));
});
check('bulk reminder lists every borrower and totals their dues', () => {
  const msg = buildBulkReminderMessage(
    [
      { borrowerName: 'Alicia', amountDue: 500, dueDate: '2026-09-01', daysLate: 20 },
      { borrowerName: 'Ben', amountDue: 750, dueDate: '2026-09-25', daysLate: -4 },
    ],
    'Barangay Treasury',
    'PHP '
  );
  assert.ok(msg.includes('Alicia') && msg.includes('Ben'));
  assert.ok(msg.includes('20d overdue'));
  assert.ok(msg.includes('1,250.00'));
});

console.log('\n[8] Seal payload (the string a published seal code is computed from)');
const sealPayload = {
  period: '2026-09',
  orgName: 'Barangay Treasury',
  chainHead: 'a'.repeat(64),
  auditCount: 42,
  inflowTotal: 10500,
  outflowTotal: 2500.5,
  outstandingTotal: 8750,
  overdueTotal: 875,
  activeLoans: 3,
  borrowerCount: 3,
};
check('payload is stable for identical inputs', () =>
  assert.strictEqual(buildSealPayload(sealPayload), buildSealPayload({ ...sealPayload })));
check('money is fixed to 2 decimals so rendering cannot change the digest', () => {
  const a = buildSealPayload({ ...sealPayload, inflowTotal: 100 });
  const b = buildSealPayload({ ...sealPayload, inflowTotal: 100.0 });
  assert.strictEqual(a, b);
  assert.ok(a.includes('|100.00|'));
});
check('any change to a sealed figure changes the payload', () => {
  assert.notStrictEqual(
    buildSealPayload(sealPayload),
    buildSealPayload({ ...sealPayload, overdueTotal: 876 })
  );
  assert.notStrictEqual(
    buildSealPayload(sealPayload),
    buildSealPayload({ ...sealPayload, chainHead: 'b'.repeat(64) })
  );
});
check('payload carries its own version tag', () =>
  assert.ok(buildSealPayload(sealPayload).startsWith('TREASURER-VAULT-SEAL-v1|')));

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ' — all good'}\n`);

