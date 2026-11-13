/**
 * ============================================================================
 *  CONFIGURATION: edit this file for your business.
 * ============================================================================
 *
 * Secrets (API keys) do NOT go here. Put them in Project Settings ->
 * Script Properties:
 *   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET   (Toast Analytics API credential)
 *   QBO_CLIENT_ID,   QBO_CLIENT_SECRET     (Intuit developer app keys)
 *
 * Account / class / location names below must match QuickBooks exactly
 * (case-insensitive). Sub-accounts can be written "Parent:Child".
 * Run `checkSetup` after editing; it lists anything QuickBooks can't find.
 */
var CONFIG = {
  toast: {
    apiHost: 'https://ws-api.toasttab.com',
    // Restaurant GUIDs to include. Empty = every location the credential sees.
    // Run `checkSetup` to print the GUID and name of each location.
    restaurantIds: [
      'e46bdc5d-4dbd-4103-9bdf-c270aaad4610', // Stacks Burgers - Truck 2
      '257c9926-e0f6-478f-aa82-5db0a7f8931b', // Stacks Burgers - Tacoma
      '81257d52-4aaa-4c02-a028-3e4c2159524b', // Stacks Burgers Food Trailer
      '39c00539-3850-487e-a353-f2285b5104ac', // Stacks Truck 4 - Truck 4
      // Not included: Stacks Burgers Truck 3 (dc37ea3a-c84d-44ec-a787-895fa09f45f5)
      // Not included: Independent Kitchen LLC (test mode)
    ],
  },

  qbo: {
    environment: 'production', // 'production' or 'sandbox'
    minorVersion: 75,
  },

  sync: {
    // Start in dry-run. Nothing is written to QuickBooks until this is false.
    dryRun: true,

    // Each run re-checks this many past settled dates and posts anything that
    // is missing. Already-posted payouts are detected and skipped, so missed
    // runs heal themselves.
    lookbackDays: 7,

    // Toast payout statuses that are safe to post. NONE = failed payout.
    postStatuses: ['SENT', 'CAPTURED'],

    // 'deposit' (recommended: matches the bank feed line directly) or
    // 'journal'. Payouts that net to zero or below always use a journal entry.
    postingMode: 'deposit',

    // QuickBooks transaction date = Toast settled date + this many days.
    // Use 1 if your bank shows Toast deposits the day after Toast settles.
    txnDateOffsetDays: 0,

    // If Toast's per-payment detail doesn't add up to the payout's card total
    // within this many cents, the payout is HELD (not posted) and you get an
    // alert. It is retried automatically on the next run.
    reconcileToleranceCents: 100,

    // Hour of day (script time zone) for the automatic daily run.
    triggerHour: 9,

    // Where alerts and summaries go. Blank = the Google account running this.
    alertEmail: '',
    sendDailySummary: true,

    // Optional Drive folder ID for a JSON audit file per payout. Blank = off.
    auditFolderId: '',

    // Apps Script stops a run after 6 minutes; we stop starting new work at
    // this point and finish the rest on the next run.
    timeBudgetMs: 4.5 * 60 * 1000,
  },

  /**
   * Default QuickBooks accounts. Every location uses these unless it has an
   * override in `locations` below.
   */
  accounts: {
    deposit: 'Checking - 7887',            // bank account Toast pays into (confirmed)
    sales: 'Sales',                        // income: food & beverage sales
    salesTax: 'Sales Tax Payable - Toast', // liability (TO CONFIRM: name of your sales tax liability account)
    tips: 'Tips Payable',                  // liability (TO CONFIRM: card tips owed to staff)
    gratuity: 'Tips Payable',              // liability: auto-gratuity / service charges paid to staff
    refunds: 'Refunds & Discounts',        // contra-income
    fees: 'Bank Charges & Fees',           // expense: card processing fees
    unallocatedWithholding: 'Bookkeeping Suspense - Unresolved Balances', // anything the rules below don't explain
    reconciliationDifference: 'Bookkeeping Suspense - Unresolved Balances', // penny rounding from Toast
  },

  /**
   * Optional per-location settings, keyed by restaurant GUID or by the exact
   * Toast restaurant name. All fields are optional.
   *
   *   'Stacks Burgers - Tacoma': {
   *     department: 'Tacoma',        // QuickBooks Location
   *     class: 'Restaurant',         // QuickBooks Class
   *     defaultTaxRate: 0.103,       // used only if Toast has no tax detail for a check
   *     accounts: { sales: 'Sales:Tacoma', deposit: 'Tacoma Checking' },
   *   },
   */
  locations: {},

  /**
   * Toast reports every withholding (Toast Capital, equipment lease / Easy
   * Pay, Instant Deposit, etc.) as ONE combined amount per payout. These rules
   * split it into the right accounts. They run in order:
   *   method 'fixed'     -> a set dollar amount per payout (equipment leases)
   *   method 'percent'   -> percent of `percentOf` ('payment' = card sales,
   *                         'withholding' = total withheld)
   *   method 'matchPayout' -> the same amount as the payout (Toast Checking 50/50 auto savings)
   *   method 'remainder' -> whatever is left
   * Any amount still left goes to accounts.unallocatedWithholding and you get
   * an alert.
   * `locations`: ['*'] for all, or a list of GUIDs / restaurant names.
   * `startDate` / `endDate` (YYYYMMDD, optional) limit when a rule applies.
   */
  withholdingRules: [
    // From Toast Payout Details + the Capital dashboard (Nov 2026).
    { name: 'Toast Capital loan repayment (19.8% of card sales)', account: 'Toast Capital loan',
      method: 'percent', percent: 19.8, percentOf: 'payment', locations: ['257c9926-e0f6-478f-aa82-5db0a7f8931b'] }, // Tacoma
    { name: 'Toast equipment lease (0.75% of card sales)', account: 'Machinery & Equipment',
      method: 'percent', percent: 0.75, percentOf: 'payment', locations: ['257c9926-e0f6-478f-aa82-5db0a7f8931b'] }, // Tacoma
    // Auto savings: Toast sends about the same amount to Toast Checking as to the bank.
    { name: 'Auto savings to Toast Checking', account: 'Toast Checking (3569)', method: 'matchPayout', locations: ['*'] },
    // Small items Toast doesn't itemize in the API (delivery/Uber Eats fees, Toast credit card,
    // marketplace facilitator tax). Allocate monthly from Toast's payout statement.
    { name: 'Other Toast withholdings (delivery fees, Toast credit card, MPF tax)',
      account: 'Toast Capital Payments Pending Allocation', method: 'remainder', locations: ['*'] },
  ],

  /**
   * Money taken out of the payout AFTER withholdings, before it reaches your
   * outside bank: for example, a portion swept into a Toast checking account.
   * Each split becomes a transfer line to that QuickBooks account, and the
   * deposit to `accounts.deposit` is reduced by the same amount.
   *   method 'fixed'   -> `amount` dollars per payout
   *   method 'percent' -> `percent` percent of the payout
   */
  payoutSplits: [
    // { name: 'Toast checking', account: 'Toast Checking', method: 'percent', percent: 10, locations: ['*'] },
  ],
};
