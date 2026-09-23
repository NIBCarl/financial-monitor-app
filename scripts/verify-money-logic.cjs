/* Verification harness for the pure money/logic modules (compiled from src/utils). */
const assert = require('assert');
const path = require('path');

const validation = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'validation.js'));
const financial = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'financial.js'));
const reminderText = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'reminderText.js'));
const sealText = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'sealText.js'));
const money = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'money.js'));
const penalties = require(path.join(__dirname, '..', '.verify-tmp', 'utils', 'penalties.js'));

const { parseMoney, parsePositiveMoney, parseTermCount, parseInterestRate, round2, sanitizePhoneForUri, csvCell, csvRow, MAX_MONEY } = validation;
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
const {
  toCents,
  fromCents,
  sumPesosToCents,
  percentOfCents,
  splitCents,
  canonicalMoney,
  roundHalfAwayFromZero,
} = money;
const { computePenalty, describePenaltyRule } = penalties;

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

console.log('\n[9] CSV export safety (formula injection + RFC 4180 quoting)');
check('a formula-looking name cannot execute in a spreadsheet', () => {
  const cell = csvCell('=HYPERLINK("http://evil.example","Pay here")');
  assert.ok(cell.startsWith('"\'='), `expected an apostrophe guard, got ${cell}`);
});
check('other formula sigils are guarded too', () => {
  ['+1+1', '@SUM(A1)', '\tcmd', '\rcmd'].forEach((raw) => {
    assert.ok(csvCell(raw).includes(`'${raw}`) || csvCell(raw).replace(/"/g, '').startsWith("'"), raw);
  });
});
check('genuine numbers stay numeric (no spurious apostrophe)', () => {
  assert.strictEqual(csvCell(-500), '"-500"');
  assert.strictEqual(csvCell(1234.56), '"1234.56"');
  assert.strictEqual(csvCell(0), '"0"');
});
check('embedded quotes are doubled, not left to break the row', () =>
  assert.strictEqual(csvCell('Nena "Bebang" Cruz'), '"Nena ""Bebang"" Cruz"'));
check('commas and newlines stay inside the quoted field', () => {
  assert.strictEqual(csvCell('Cruz, Nena'), '"Cruz, Nena"');
  assert.strictEqual(csvCell('line1\nline2'), '"line1\nline2"');
});
check('null and undefined become an empty cell rather than "null"', () => {
  assert.strictEqual(csvCell(null), '""');
  assert.strictEqual(csvCell(undefined), '""');
});
check('a full row keeps its column count even with commas in the name', () => {
  const row = csvRow(['Cruz, Nena', '0917 123 4567', '=bad', 1, 250.5, 'NO']);
  assert.strictEqual(row.split('","').length, 6);
});

console.log('\n[10] Money layer (integer centavos — the drift guarantee)');
check('pesos <-> centavos round-trips exactly', () => {
  assert.strictEqual(toCents(10.01), 1001);
  assert.strictEqual(fromCents(1001), 10.01);
  assert.strictEqual(toCents(2625), 262500);
  assert.strictEqual(fromCents(262500), 2625);
});
check('rounding is half-away-from-zero, not Math.round', () => {
  assert.strictEqual(roundHalfAwayFromZero(2.5), 3);
  assert.strictEqual(roundHalfAwayFromZero(-2.5), -3); // Math.round(-2.5) === -2, which loses a centavo
  assert.strictEqual(toCents(0.005), 1);
  assert.strictEqual(fromCents(1), 0.01);
});
check('the classic float drift cannot survive canonicalMoney', () => {
  assert.notStrictEqual(0.1 + 0.2, 0.3); // the raw float really is 0.30000000000000004
  assert.strictEqual(canonicalMoney(0.1 + 0.2), 0.3);
  assert.strictEqual(canonicalMoney(0.01 * 1000), 10);
});
check('summing a thousand centavo amounts stays exact', () => {
  const amounts = Array.from({ length: 1000 }, (_, i) => i + 0.01);
  // 0.01 added a thousand times is 10.000000000000002 as a raw float; the money layer returns 10.
  assert.strictEqual(fromCents(sumPesosToCents(amounts)), 499510);
  assert.strictEqual(sumPesosToCents(Array.from({ length: 1000 }, () => 0.01)), toCents(10));
});
check('canonicalMoney is idempotent', () => {
  const once = canonicalMoney(10500.005);
  assert.strictEqual(canonicalMoney(once), once);
});
check('the maximum allowed amount still round-trips', () =>
  assert.strictEqual(fromCents(toCents(MAX_MONEY)), 999999999.99));
check('percentOfCents is exact (5% of PHP 105.00)', () =>
  assert.strictEqual(percentOfCents(10500, 5), 525));
check('percentOfCents rounds half away from zero', () =>
  assert.strictEqual(percentOfCents(1005, 2.5), 25)); // 25.125 -> 25
check('splitCents always sums to the total, remainder on the last part', () => {
  assert.deepStrictEqual(splitCents(10500, 4), [2625, 2625, 2625, 2625]);
  assert.deepStrictEqual(splitCents(10000, 3), [3333, 3333, 3334]);
  assert.strictEqual(splitCents(10000, 3).reduce((a, b) => a + b, 0), 10000);
  assert.strictEqual(splitCents(1, 3).reduce((a, b) => a + b, 0), 1);
});
check('no money is created or destroyed by a schedule', () => {
  const result = calculateAmortization({
    principal: 9999.99,
    interestRate: 3.75,
    interestType: 'FLAT',
    frequency: 'MONTHLY',
    termCount: 7,
    startDate: '2026-01-31',
  });
  const scheduleCents = sumPesosToCents(result.installments.map((i) => i.expectedAmount));
  assert.strictEqual(scheduleCents, toCents(result.totalPayable));
  assert.strictEqual(result.installments.length, 7);
});

console.log('\n[11] Penalty rules (scope / amount-or-percent / day-week-month)');
const daily = { basis: 'FLAT', amount: 20, period: 'DAY', graceDays: 0 };
const weekly2pct = { basis: 'PERCENT', amount: 2, period: 'WEEK', graceDays: 3 };
check('a flat daily penalty multiplies by the days late', () => {
  const r = computePenalty(daily, 2625, 5);
  assert.strictEqual(r.periods, 5);
  assert.strictEqual(r.amount, 100);
});
check('grace days are subtracted before anything is charged', () => {
  assert.strictEqual(computePenalty(weekly2pct, 2625, 3).amount, 0); // still inside grace
  assert.strictEqual(computePenalty(weekly2pct, 2625, 3).periods, 0);
});
check('a weekly percentage charges whole weeks only', () => {
  const r = computePenalty(weekly2pct, 2625, 17); // 17 - 3 grace = 14 days = 2 whole weeks
  assert.strictEqual(r.periods, 2);
  assert.strictEqual(r.chargeableDays, 14);
  assert.strictEqual(r.amount, 105); // 2% x 2 periods of 2,625 = 105.00
});
check('day 10 of a fortnight is still only one week charged', () => {
  assert.strictEqual(computePenalty(weekly2pct, 2625, 10).periods, 1);
  assert.strictEqual(computePenalty(weekly2pct, 2625, 9).periods, 0); // 9-3=6 days < 1 week
});
check('a monthly percentage uses whole 30-day months', () => {
  const monthly = { basis: 'PERCENT', amount: 5, period: 'MONTH', graceDays: 0 };
  assert.strictEqual(computePenalty(monthly, 10000, 29).periods, 0);
  assert.strictEqual(computePenalty(monthly, 10000, 30).periods, 1);
  assert.strictEqual(computePenalty(monthly, 10000, 30).amount, 500);
  assert.strictEqual(computePenalty(monthly, 10000, 61).periods, 2);
});
check('the cap limits a single installment, not the periods', () => {
  const capped = { basis: 'FLAT', amount: 50, period: 'DAY', graceDays: 0, capAmount: 200 };
  const r = computePenalty(capped, 2625, 9); // 9 x 50 = 450, capped at 200
  assert.strictEqual(r.periods, 9);
  assert.strictEqual(r.amount, 200);
});
check('a penalty is never charged on a not-yet-late installment', () =>
  assert.strictEqual(computePenalty(daily, 2625, 0).amount, 0));
check('penalty arithmetic stays centavo-exact', () => {
  // 1.5% per week of 1,000.01 for 3 weeks = 45.00 (4,500.045 cents -> half away from zero)
  const r = computePenalty({ basis: 'PERCENT', amount: 1.5, period: 'WEEK', graceDays: 0 }, 1000.01, 21);
  assert.strictEqual(r.periods, 3);
  assert.strictEqual(r.amount, 45);
});
check('the rule is described in words the treasurer can check', () => {
  assert.strictEqual(
    describePenaltyRule(weekly2pct, 'PHP '),
    '2% of the installment per week after 3 days grace'
  );
  assert.strictEqual(
    describePenaltyRule({ basis: 'FLAT', amount: 25, period: 'DAY', graceDays: 1, capAmount: 500 }, 'PHP '),
    'PHP 25.00 per day after 1 day grace (cap PHP 500.00)'
  );
});

check('payments clear penalties oldest first and leave the rest as credit', () => {
  const split = penalties.splitPaymentAcrossCharges(300, [
    { id: 'c1', amount: 100, paidAmount: 0 },
    { id: 'c2', amount: 250, paidAmount: 50 },
  ]);
  assert.strictEqual(split.penaltyApplied, 300);
  assert.strictEqual(split.leftover, 0);
  assert.deepStrictEqual(split.updates, [
    { id: 'c1', newPaidAmount: 100 },
    { id: 'c2', newPaidAmount: 250 },
  ]);
});

check('a payment smaller than a fine part-pays it and stops', () => {
  const split = penalties.splitPaymentAcrossCharges(40.25, [
    { id: 'c1', amount: 100, paidAmount: 0 },
    { id: 'c2', amount: 500, paidAmount: 0 },
  ]);
  assert.strictEqual(split.penaltyApplied, 40.25);
  assert.strictEqual(split.leftover, 0);
  assert.deepStrictEqual(split.updates, [{ id: 'c1', newPaidAmount: 40.25 }]);
});

check('what the fines cannot absorb is left over, centavo-exact', () => {
  const split = penalties.splitPaymentAcrossCharges(0.05, [{ id: 'c1', amount: 0.03, paidAmount: 0 }]);
  assert.strictEqual(split.penaltyApplied, 0.03);
  assert.strictEqual(split.leftover, 0.02);
  assert.strictEqual(split.updates[0].newPaidAmount, 0.03);
});

check('already-settled or waived-out fines are skipped, not paid twice', () => {
  const split = penalties.splitPaymentAcrossCharges(100, [
    { id: 'paid', amount: 50, paidAmount: 50 },
    { id: 'overpaid', amount: 50, paidAmount: 80 },
    { id: 'open', amount: 30, paidAmount: 0 },
  ]);
  assert.strictEqual(split.penaltyApplied, 30);
  assert.strictEqual(split.leftover, 70);
  assert.deepStrictEqual(split.updates, [{ id: 'open', newPaidAmount: 30 }]);
});

check('no leftover cash means no penalty allocation at all', () => {
  const split = penalties.splitPaymentAcrossCharges(0, [{ id: 'c1', amount: 100, paidAmount: 0 }]);
  assert.strictEqual(split.penaltyApplied, 0);
  assert.strictEqual(split.updates.length, 0);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ' — all good'}\n`);

