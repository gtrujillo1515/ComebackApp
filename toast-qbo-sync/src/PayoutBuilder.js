/**
 * Pure accounting logic: turns one Toast payout (one location, one settled
 * date) plus its per-payment and per-check detail into a balanced set of
 * accounting lines. No network calls here, so this is fully unit-tested.
 *
 * Toast's numbers for a payout:
 *   payoutAmount = paymentAmount - refundAmount - totalFeeAmount - withholdingAmount
 *
 * What we book (credits = money in, debits = where it went):
 *   CREDIT  Sales           card payments minus tax, tips and gratuity
 *   CREDIT  Sales tax       tax portion of those card payments (from check detail)
 *   CREDIT  Tips payable    card tips
 *   CREDIT  Gratuity        auto-gratuity
 *   DEBIT   Refunds         card refunds settled in this payout
 *   DEBIT   Card fees       processing fees
 *   DEBIT   Withholdings    split by CONFIG.withholdingRules (Capital, lease, ...)
 *   DEBIT   Payout splits   e.g. Toast checking sweep
 *   DEBIT   Bank            what actually lands in the outside bank account
 */

/** Merge default accounts with any per-location overrides. */
function locationSettings(config, restaurantGuid, restaurantName) {
  var locs = config.locations || {};
  var loc = locs[restaurantGuid];
  if (!loc) {
    var want = normName(restaurantName);
    Object.keys(locs).forEach(function (k) {
      if (!loc && normName(k) === want) loc = locs[k];
    });
  }
  loc = loc || {};
  var accounts = {};
  Object.keys(config.accounts).forEach(function (k) { accounts[k] = config.accounts[k]; });
  Object.keys(loc.accounts || {}).forEach(function (k) { accounts[k] = loc.accounts[k]; });
  return {
    name: String(restaurantName || '').trim(),
    department: loc.department || '',
    klass: loc.class || '',
    defaultTaxRate: typeof loc.defaultTaxRate === 'number' ? loc.defaultTaxRate : null,
    accounts: accounts,
  };
}

/** Does a withholding rule / payout split apply to this location and date? */
function ruleApplies(rule, restaurantGuid, restaurantName, settledDate) {
  var locs = rule.locations && rule.locations.length ? rule.locations : ['*'];
  var match = locs.some(function (l) {
    return l === '*' || l === restaurantGuid || normName(l) === normName(restaurantName);
  });
  if (!match) return false;
  var d = toYmd(settledDate);
  if (rule.startDate && d < toYmd(rule.startDate)) return false;
  if (rule.endDate && d > toYmd(rule.endDate)) return false;
  return true;
}

/**
 * Sum tips, gratuity and sales tax across the card payments in one payout.
 * Tax per payment = payment subtotal x (check tax / check pre-tip total),
 * where check pre-tip total = checkTotalAmount - checkTipAmount - checkGratuityAmount
 * (Toast's check total includes tax and tip). Falls back to the location's
 * defaultTaxRate (tax-inclusive) when the check isn't available.
 */
function computeCardComponents(payments, checksByGuid, defaultTaxRate) {
  var out = {
    count: 0, totalCents: 0, subtotalCents: 0, tipCents: 0, gratuityCents: 0, taxCents: 0,
    taxFromChecks: 0, taxFromRate: 0, taxMissing: 0,
  };
  (payments || []).forEach(function (p) {
    var total = toCents(p.paymentTotal);
    var sub = toCents(p.paymentSubtotal);
    var tip = toCents(p.tipAmount);
    var grat = toCents(p.gratuityAmount);
    out.count++;
    out.totalCents += total;
    out.subtotalCents += sub;
    out.tipCents += tip;
    out.gratuityCents += grat;

    var check = checksByGuid ? checksByGuid[p.checkGuid] : null;
    var tax = null;
    if (check) {
      var cTax = toCents(check.checkTaxAmount);
      var cPreTip = toCents(check.checkTotalAmount) - toCents(check.checkTipAmount) - toCents(check.checkGratuityAmount);
      if (cPreTip > 0) {
        tax = Math.round(sub * cTax / cPreTip);
        out.taxFromChecks++;
      } else if (cTax === 0) {
        tax = 0;
        out.taxFromChecks++;
      }
    }
    if (tax === null) {
      if (defaultTaxRate !== null && defaultTaxRate !== undefined) {
        tax = Math.round(sub * defaultTaxRate / (1 + defaultTaxRate));
        out.taxFromRate++;
      } else {
        tax = 0;
        out.taxMissing++;
      }
    }
    if (tax > sub) tax = sub;
    if (tax < 0 && sub >= 0) tax = 0;
    out.taxCents += tax;
  });
  return out;
}

/** How much a non-remainder rule wants to take, in cents. */
function ruleWantCents(r, withholdingCents, ctx) {
  if (r.method === 'fixed') return toCents(r.amount);
  if (r.method === 'percent') {
    var base = r.percentOf === 'withholding' ? withholdingCents : ctx.paymentCents;
    var exact = base * Number(r.percent) / 100;
    // Toast rounds its percentage withholdings up to the next cent.
    return r.round === 'up' ? Math.ceil(exact - 1e-9) : Math.round(exact);
  }
  if (r.method === 'matchPayout') {
    return Math.round((ctx.payoutCents || 0) * (r.percent === undefined ? 100 : Number(r.percent)) / 100);
  }
  throw new Error('Unknown withholding rule method "' + r.method + '" on rule "' + r.name + '"');
}

function allocateWithholdingOnce_(withholdingCents, ctx, applicable) {
  var lines = [];
  var remaining = withholdingCents;
  var shortCents = 0; // what the rules wanted but Toast didn't withhold
  var leftoverCents = 0; // what a remainder rule had to absorb
  if (withholdingCents > 0) {
    applicable.forEach(function (r) {
      if (r.method === 'remainder') return;
      var want = Math.max(ruleWantCents(r, withholdingCents, ctx), 0);
      var take = Math.min(want, Math.max(remaining, 0));
      shortCents += want - take;
      if (take > 0) {
        lines.push({ name: r.name, account: r.account, cents: take });
        remaining -= take;
      }
    });
  }
  // Remainder rules, in order: the first whose limits fit takes what's left.
  // maxCents / maxPercentOfPayment let a rule take only small leftovers
  // (rounding, delivery fees) so a big unexplained amount is held instead.
  if (remaining !== 0) {
    var abs = Math.abs(remaining);
    var rr = applicable.filter(function (r) {
      if (r.method !== 'remainder') return false;
      if (r.maxCents !== undefined && abs > r.maxCents) return false;
      if (r.maxPercentOfPayment !== undefined && abs > ctx.paymentCents * r.maxPercentOfPayment / 100) return false;
      return true;
    })[0];
    if (rr) {
      lines.push({ name: rr.name, account: rr.account, cents: remaining });
      leftoverCents = abs;
      remaining = 0;
    }
  }
  return { lines: lines, unallocatedCents: remaining, shortCents: shortCents, leftoverCents: leftoverCents };
}

/**
 * Split Toast's single withholding total across the configured rules.
 * Rules marked `optional: true` (loans, leases) are dropped when Toast clearly
 * didn't take them that day, i.e. when keeping them leaves the rules short.
 */
function allocateWithholding(withholdingCents, ctx, rules, toleranceCents) {
  var tol = toleranceCents === undefined ? 100 : toleranceCents;
  var applicable = (rules || []).filter(function (r) {
    return ruleApplies(r, ctx.restaurantGuid, ctx.restaurantName, ctx.settledDate);
  });
  var result = allocateWithholdingOnce_(withholdingCents, ctx, applicable);
  var optional = applicable.filter(function (r) { return r.optional; });
  if (result.shortCents <= tol || !optional.length || optional.length > 6) return result;
  // Try leaving out the fewest optional rules that makes Toast's total add up.
  var best = null;
  for (var mask = 1; mask < (1 << optional.length); mask++) {
    var dropped = optional.filter(function (r, i) { return mask & (1 << i); });
    var attempt = allocateWithholdingOnce_(withholdingCents, ctx,
      applicable.filter(function (r) { return dropped.indexOf(r) < 0; }));
    if (attempt.shortCents > tol || attempt.unallocatedCents !== 0) continue;
    // Prefer the closest fit (smallest leftover), then the fewest rules left out.
    if (!best || attempt.leftoverCents < best.leftoverCents ||
        (attempt.leftoverCents === best.leftoverCents && dropped.length < best.skippedOptional.length)) {
      attempt.skippedOptional = dropped.map(function (r) { return r.name; });
      best = attempt;
    }
  }
  return best || result;
}

/** Amounts swept out of the payout before it reaches the outside bank. */
function computePayoutSplits(payoutCents, ctx, splits) {
  var lines = [];
  var remaining = Math.max(payoutCents, 0);
  (splits || []).forEach(function (s) {
    if (!ruleApplies(s, ctx.restaurantGuid, ctx.restaurantName, ctx.settledDate)) return;
    var want;
    if (s.method === 'fixed') want = toCents(s.amount);
    else if (s.method === 'percent') want = Math.round(payoutCents * Number(s.percent) / 100);
    else throw new Error('Unknown payout split method "' + s.method + '" on split "' + s.name + '"');
    var take = Math.min(Math.max(want, 0), remaining);
    if (take > 0) {
      lines.push({ name: s.name, account: s.account, cents: take });
      remaining -= take;
    }
  });
  return lines;
}

/**
 * Build the full breakdown for one payout row.
 * @param {Object} args
 *   row           one element of the /era/v1/payout (settled date) report
 *   payments      /era/v1/payout/payments rows for THIS restaurant + settled date
 *   checksByGuid  checkGuid -> /era/v1/check row
 *   config        CONFIG
 */
function buildPayoutBreakdown(args) {
  var row = args.row;
  var config = args.config;
  var settledDate = toYmd(row.settledDate);
  var guid = row.restaurantGuid;
  var name = String(row.restaurantName || '').trim();
  var loc = locationSettings(config, guid, name);
  var acct = loc.accounts;
  var tolerance = config.sync.reconcileToleranceCents;

  var c = {
    payment: toCents(row.paymentAmount),
    refund: toCents(row.refundAmount),
    fee: toCents(row.totalFeeAmount),
    withholding: toCents(row.withholdingAmount),
    payout: toCents(row.payoutAmount),
  };

  var warnings = [];
  var holdReasons = [];
  var card = computeCardComponents(args.payments, args.checksByGuid, loc.defaultTaxRate);

  // Do the per-payment details add up to the card total Toast settled?
  var cardDiff = c.payment - card.totalCents;
  if (Math.abs(cardDiff) > tolerance) {
    holdReasons.push('Per-payment detail (' + card.count + ' payments, ' + formatMoney(card.totalCents) +
      ') does not match Toast payout card total ' + formatMoney(c.payment) + '.');
  } else if (cardDiff !== 0) {
    warnings.push('Card detail differs from payout total by ' + formatMoney(cardDiff) + '; booked to sales.');
  }
  if (card.taxMissing > 0) {
    warnings.push(card.taxMissing + ' payment(s) had no check tax detail and no defaultTaxRate; tax booked as $0 for them.');
  }
  if (card.taxFromRate > 0) {
    warnings.push(card.taxFromRate + ' payment(s) used the location defaultTaxRate because check detail was unavailable.');
  }

  var taxCents = card.taxCents;
  var tipCents = card.tipCents;
  var gratCents = card.gratuityCents;
  var salesCents = c.payment - taxCents - tipCents - gratCents;
  if (salesCents < 0 && c.payment >= 0) {
    holdReasons.push('Computed sales are negative (' + formatMoney(salesCents) + '); detail looks inconsistent.');
  }

  var ctx = { restaurantGuid: guid, restaurantName: name, settledDate: settledDate, paymentCents: c.payment, payoutCents: c.payout };
  var wh = allocateWithholding(c.withholding, ctx, config.withholdingRules, tolerance);
  var strict = config.sync.holdUnexplainedWithholding !== false;
  if (wh.shortCents > tolerance) {
    holdReasons.push('Toast withheld ' + formatMoney(wh.shortCents) + ' less than the withholding rules expect; ' +
      'rates were probably different on this date (add startDate/endDate to the rules).');
  }
  if (wh.unallocatedCents !== 0) {
    var msg = formatMoney(wh.unallocatedCents) + ' of Toast withholdings is not explained by the withholding rules';
    if (strict) {
      holdReasons.push(msg + ' (' + formatMoney(c.withholding) + ' withheld in total). Check this payout in Toast.');
    } else {
      warnings.push(msg + '; booked to "' + acct.unallocatedWithholding + '".');
    }
  }
  if (wh.skippedOptional && wh.skippedOptional.length) {
    warnings.push('Not taken by Toast on this date, so skipped: ' + wh.skippedOptional.join(', ') + '.');
  }

  var splits = computePayoutSplits(c.payout, ctx, config.payoutSplits);
  var splitTotal = splits.reduce(function (s, l) { return s + l.cents; }, 0);
  var bankCents = c.payout - splitTotal;

  // Toast's payoutAmount should equal the formula; book any penny difference.
  var formulaPayout = c.payment - c.refund - c.fee - c.withholding;
  var payoutDiff = c.payout - formulaPayout;
  if (Math.abs(payoutDiff) > tolerance) {
    holdReasons.push('Toast payoutAmount ' + formatMoney(c.payout) + ' differs from payments - refunds - fees - withholdings (' +
      formatMoney(formulaPayout) + ').');
  }

  var lines = [];
  function add(role, label, account, cents, side) {
    if (cents !== 0) lines.push({ role: role, label: label, account: account, cents: cents, side: side });
  }
  add('sales', 'Card sales', acct.sales, salesCents, 'credit');
  add('salesTax', 'Sales tax on card sales', acct.salesTax, taxCents, 'credit');
  add('tips', 'Card tips', acct.tips, tipCents, 'credit');
  add('gratuity', 'Auto-gratuity', acct.gratuity, gratCents, 'credit');
  add('refunds', 'Card refunds', acct.refunds, c.refund, 'debit');
  add('fees', 'Card processing fees', acct.fees, c.fee, 'debit');
  wh.lines.forEach(function (l) { add('withholding', l.name, l.account, l.cents, 'debit'); });
  add('withholding', 'Unallocated Toast withholding', acct.unallocatedWithholding, wh.unallocatedCents, 'debit');
  splits.forEach(function (l) { add('split', l.name, l.account, l.cents, 'debit'); });
  add('reconciliation', 'Toast payout rounding', acct.reconciliationDifference, -payoutDiff, 'debit');

  // Balance check: credits must equal debits + bank.
  var credits = 0, debits = 0;
  lines.forEach(function (l) { if (l.side === 'credit') credits += l.cents; else debits += l.cents; });
  if (credits !== debits + bankCents) {
    holdReasons.push('Internal balance check failed (credits ' + formatMoney(credits) + ' vs debits+bank ' +
      formatMoney(debits + bankCents) + ').');
  }

  return {
    key: payoutKey(guid, settledDate),
    restaurantGuid: guid,
    restaurantName: name,
    settledDate: settledDate,
    payoutStatus: row.payoutStatus || '',
    salesPeriodStart: row.salesPeriodStartDateTime || '',
    salesPeriodEnd: row.salesPeriodEndDateTime || '',
    transactionCount: row.transactionCount,
    location: loc,
    toast: c,
    card: card,
    bankCents: bankCents,
    bankAccount: acct.deposit,
    lines: lines,
    warnings: warnings,
    holdReasons: holdReasons,
    ok: holdReasons.length === 0,
  };
}

/** One-line human summary for logs and emails. */
function describeBreakdown(b) {
  var parts = b.lines.map(function (l) {
    return (l.side === 'credit' ? '+' : '-') + l.label + ' ' + formatMoney(l.cents);
  });
  return b.restaurantName + ' ' + ymdToIso(b.settledDate) + ': bank ' + formatMoney(b.bankCents) +
    ' = ' + parts.join(', ');
}
