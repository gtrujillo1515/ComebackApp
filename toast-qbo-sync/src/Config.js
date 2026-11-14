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
    // ON/OFF SWITCH and START DATE live in Script Properties (Project Settings),
    // so pasting a new version of this file never changes them:
    //   SYNC_MODE  = live       -> writes to QuickBooks. Anything else = dry run.
    //   START_DATE = 20261114   -> never posts payouts settled before this date.

    // Each run re-checks this many past settled dates and posts anything that
    // is missing. Already-posted payouts are detected and skipped, so missed
    // runs heal themselves.
    lookbackDays: 14,

    // Toast payout statuses that are safe to post. SENT = Toast sent it to the
    // bank. CAPTURED payouts wait until they're SENT; NONE = failed.
    postStatuses: ['SENT'],

    // 'deposit' (recommended: matches the bank feed line directly) or
    // 'journal'. Payouts that net to zero or below always use a journal entry.
    postingMode: 'journal',

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
    // Your bank rules (#287/#288 for Checking - 7887, #305 for Toast Checking and its
    // jars) already add every Toast deposit to Sales:Toast Clearing. Each payout's
    // journal entry moves that money back out of Toast Clearing into the right
    // accounts, so Toast Clearing nets to ~$0 and nothing needs matching by hand.
    deposit: 'Sales:Toast Clearing',
    sales: 'Sales',                        // income: food & beverage sales
    salesTax: 'Sales Tax Collected - Toast', // liability; QuickBooks blocks posting to its built-in tax accounts
    tips: 'Tips Payable',                  // liability (TO CONFIRM: card tips owed to staff)
    gratuity: 'Tips Payable',              // liability: auto-gratuity / service charges paid to staff
    refunds: 'Refunds & Discounts',        // contra-income
    fees: 'Bank Charges & Fees',           // expense: card processing fees
    unallocatedWithholding: 'Bookkeeping Suspense - Unresolved Balances', // anything the rules below don't explain
    reconciliationDifference: 'Bookkeeping Suspense - Unresolved Balances', // penny rounding from Toast
  },

  /**
   * Cash sales from Toast's Standard API (Script Properties TOAST_STD_CLIENT_ID,
   * TOAST_STD_CLIENT_SECRET, and CASH_START_DATE = first business date to post).
   * Each day: DEBIT onHandAccount, CREDIT sales / sales tax / tips. A bank rule
   * moves each cash deposit out of onHandAccount, so its balance is cash not yet
   * deposited.
   */
  cash: {
    enabled: true,
    onHandAccount: 'Cash on Hand - Toast',
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
   *   `round: 'up'` rounds a percent rule up to the next cent, as Toast does
   *   `optional: true` lets a rule be skipped on dates Toast clearly didn't take it
   *   remainder rules may limit themselves with maxCents / maxPercentOfPayment
   *   method 'remainder' -> whatever is left
   * Any amount still left goes to accounts.unallocatedWithholding and you get
   * an alert.
   * `locations`: ['*'] for all, or a list of GUIDs / restaurant names.
   * `startDate` / `endDate` (YYYYMMDD, optional) limit when a rule applies.
   */
  withholdingRules: [
    // From Toast Payout Details + the Capital dashboards (Nov 2026). Percent = % of card sales.
    // optional: true -> skipped automatically on dates Toast didn't take it (before a loan started).
    { name: 'Toast Capital loan - Tacoma (19.8%)', account: 'Toast Capital loan', optional: true,
      method: 'percent', percent: 19.8, percentOf: 'payment', round: 'up', locations: ['257c9926-e0f6-478f-aa82-5db0a7f8931b'] },
    { name: 'Toast Capital loan - Truck 2 (12.05%)', account: 'Toast Capital loan', optional: true,
      method: 'percent', percent: 12.05, percentOf: 'payment', round: 'up', locations: ['e46bdc5d-4dbd-4103-9bdf-c270aaad4610'] },
    { name: 'Toast Capital loan - Truck 4 (12.99%)', account: 'Toast Capital loan', optional: true,
      method: 'percent', percent: 12.99, percentOf: 'payment', round: 'up', locations: ['39c00539-3850-487e-a353-f2285b5104ac'] },
    { name: 'Toast equipment lease - Tacoma (0.75%)', account: 'Machinery & Equipment', optional: true,
      method: 'percent', percent: 0.75, percentOf: 'payment', locations: ['257c9926-e0f6-478f-aa82-5db0a7f8931b'] },
    { name: 'Toast Credit Card repayment - Tacoma (0.5%)', account: 'Toast Credit Card', optional: true,
      method: 'percent', percent: 0.5, percentOf: 'payment', round: 'up', locations: ['257c9926-e0f6-478f-aa82-5db0a7f8931b'] },
    // Auto savings (38% of card sales, every location). Toast sends each slice to Toast
    // Checking or a jar as a "TOAST SAV" deposit, which bank rule #305 adds to
    // Sales:Toast Clearing, so these lines clear those deposits back out of it.
    { name: 'Auto savings - Toast Checking (17%)', account: 'Sales:Toast Clearing',
      method: 'percent', percent: 17, percentOf: 'payment', round: 'up', locations: ['*'] },
    { name: 'Auto savings - Sales tax jar (17%)', account: 'Sales:Toast Clearing',
      method: 'percent', percent: 17, percentOf: 'payment', round: 'up', locations: ['*'] },
    { name: 'Auto savings - Rent jar (2%)', account: 'Sales:Toast Clearing',
      method: 'percent', percent: 2, percentOf: 'payment', round: 'up', locations: ['*'] },
    { name: 'Auto savings - Wrap Fund jar (2%)', account: 'Sales:Toast Clearing',
      method: 'percent', percent: 2, percentOf: 'payment', round: 'up', locations: ['*'] },
    // Leftovers. Pennies from Toast rounding each payment -> Toast Clearing (nets with
    // the SAV deposits). Up to 3% of card sales (delivery fees, marketplace tax) ->
    // pending allocation. Anything bigger is HELD for review instead of guessed.
    { name: 'Toast rounding', account: 'Sales:Toast Clearing', method: 'remainder', maxCents: 100, locations: ['*'] },
    { name: 'Other Toast withholdings (delivery fees, MPF tax)', account: 'Toast Capital Payments Pending Allocation',
      method: 'remainder', maxPercentOfPayment: 3, locations: ['*'] },
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
