# Toast → QuickBooks payout sync

Books every Toast card payout and every day's cash sales into QuickBooks
Online automatically, with sales, sales tax (the tax actually charged on each
check, at whatever location a truck was), tips, fees, Toast Capital loans,
the equipment lease, Toast Credit Card repayments and Toast Checking auto
savings each in their own account.

## How it fits together (Stacks / TRU TASTE, INC)

**Card payouts.** Bank rules add every Toast deposit to `Sales:Toast Clearing`:
"TOAST DEP" in Checking - 7887 (rule "Toast card payout - to Toast Clearing"),
and the 17/17/2/2 % "TOAST SAV" auto-savings deposits in Toast Checking and its
Sales tax / Rent / Wrap Fund jars (rule "Toast auto savings - to Toast
Clearing"). For each payout the program posts one journal entry that moves
that money out of Toast Clearing:

| Debit | Credit |
|---|---|
| Sales:Toast Clearing (bank deposit + auto savings) | Sales |
| Bank Charges & Fees (card fees) | Sales Tax Collected - Toast |
| Toast Capital loan (Tacoma 19.8 %, Truck 2 12.05 %, Truck 4 12.99 %) | Tips Payable |
| Machinery & Equipment (lease 0.75 %), Toast Credit Card (0.5 %) | |
| Toast Capital Payments Pending Allocation (delivery fees, MPF tax) | |

Toast Clearing nets to ~$0 per payout (pennies from Toast's per-payment
rounding). Withholding rates live in `CONFIG.withholdingRules`; loan rules are
`optional` so days before a loan started are handled, and a payout whose
withholdings don't fit the rules is **held** and emailed, never guessed.

**Cash.** From Toast's Standard API (orders), each location's cash payments per
business day are posted as: debit `Cash on Hand - Toast`, credit Sales / Sales
Tax Collected - Toast / Tips Payable. Cash is deposited only to Wells Fargo
(4014), whose rule "Cash deposit - from Cash on Hand (Toast)" moves each
"eDeposit" out of Cash on Hand. Cash on Hand = cash Toast recorded but not yet
deposited; the daily email shows it.

**Script Properties** (Apps Script → Project Settings): `TOAST_CLIENT_ID`,
`TOAST_CLIENT_SECRET` (Analytics), `TOAST_STD_CLIENT_ID`,
`TOAST_STD_CLIENT_SECRET` (Standard, orders:read), `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `START_DATE` (first card payout date), `CASH_START_DATE`
(first cash business date), `SYNC_MODE` = `live` (anything else = dry run).

**Running:** `installDailyTrigger` (daily), `startCatchUp` / `catchUpStatus`
(history from START_DATE, hourly, Toast-rate-limit aware), `previewYesterday`
and `previewCash` (dry runs), `checkSetup`, `debugPayoutDetail`,
`listQuickBooksAccounts`, `showRecentPayouts`.

Note: QuickBooks refuses direct postings to its built-in sales tax accounts, so
tax is booked to the ordinary liability `Sales Tax Collected - Toast`. Sales
tax returns are filed from Toast's reports.

## Where the numbers come from

| Toast Analytics endpoint | Used for |
|---|---|
| `/era/v1/payout/{day,week}`: payouts by **settled date** | One row per location per payout: card payments, refunds, fees, withholdings, payout amount, status |
| `/era/v1/payout/payments/day` | Every card payment in that payout, with tip and gratuity |
| `/era/v1/check/day` | Each check's tax, tip and total, used to split each payment into sales vs. tax exactly, including split checks |

Toast builds analytics reports asynchronously. The GET returns **HTTP 202** until
a report is ready. The previous job (writing `payouts-YYYYMMDD.json` into the
"Stacks Toast Payouts" Drive folder) always recorded `"payouts": []`. That is
what happens when the 202 is read as "no data". This code polls until Toast
returns 200.

### Two things the Toast API does not tell you (configure these)

1. **Withholding breakdown.** Toast reports Toast Capital, equipment lease
   (Easy Pay), Instant Deposit, etc. as one `withholdingAmount`. In
   `CONFIG.withholdingRules`, tell the script how to split it. Typically:
   a `fixed` daily amount per location for the lease, then `remainder` →
   Toast Capital Loan. Anything not covered goes to
   "Toast Withholdings - Unallocated", and you get an email.
2. **Toast checking sweep.** If part of each payout goes to a Toast checking
   account before the rest reaches your bank, add it to
   `CONFIG.payoutSplits` (`fixed` dollars or `percent` of the payout). If
   that money is instead part of Toast's withholdings, add it as a withholding
   rule.

Look at one or two Toast **Payout Details** reports (Toast Web → Reports →
Payments → Payouts) to get these amounts right. Then compare the script's
dry-run output against them.

## Safety rails

- **Dry run until you switch it on.** Nothing is written to QuickBooks until
  Script Property `SYNC_MODE` is `live`. Live posting also requires
  `START_DATE` (YYYYMMDD), and nothing settled before that date is ever posted.
- **Only SENT payouts.** CAPTURED payouts wait until Toast sends them.
- **Holds instead of guesses.** If the per-payment detail doesn't add up to
  Toast's payout total (within `reconcileToleranceCents`), that payout is
  **held**, not posted. You're emailed, and it's retried on the next run.
- **Self-healing.** Each run re-checks the last `lookbackDays` (default 14)
  settled dates and posts anything missing. Missed or failed runs catch up on
  their own.
- **Re-posting.** Delete the transaction in QuickBooks and the next run books
  it again.
- Payouts with status `NONE` (failed) are held and reported.
- If QuickBooks rejects a Deposit, the same amounts are booked as a Journal
  Entry, with a warning.

## One-time setup (about 30 minutes)

### 1. Toast Analytics API credential
Requires Toast **Restaurant Management Suite Pro** or higher.
Toast Web → **Integrations → Toast API access → Manage credentials** →
create a credential with the **Analytics** scope (`enterprise-metrics:read`).
Copy the **Client ID** and **Client secret**.

### 2. Intuit (QuickBooks) app
1. Sign in at <https://developer.intuit.com> with your QuickBooks login →
   **Create an app → QuickBooks Online and Payments**, scope **Accounting**.
2. Under **Production → Keys & credentials**, copy the Client ID and Client
   Secret. Intuit asks a short questionnaire before issuing production keys.
   For a private, single-company app the answers are simple.
3. You'll add a Redirect URI in step 4.

### 3. Create the Apps Script project
1. Go to <https://script.google.com> → **New project**, and name it "Toast QBO Sync".
2. **Project Settings** (gear) → tick *Show "appsscript.json"*. Set the time
   zone to your restaurants' zone.
3. Replace `appsscript.json` with the one in this folder. It adds the
   `OAuth2` library and the required permissions.
4. Open `Code.gs` in the editor, delete what's there, and paste in the whole
   of [`dist/Code.gs`](dist/Code.gs). Then edit the `CONFIG` block at the top.
   (Alternative: [clasp](https://github.com/google/clasp). Copy
   `.clasp.json.example` to `.clasp.json`, add your script ID, and run
   `clasp push` from this folder.)
5. **Project Settings → Script Properties**, add:
   `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`.

### 4. Connect QuickBooks
1. Run **`authorizeQuickBooks`** (approve Google's permission prompt the first time).
2. The log shows a **Redirect URI**
   (`https://script.google.com/macros/d/<id>/usercallback`). Add it under your
   Intuit app's **Production → Redirect URIs**.
3. Open the authorization link from the log, pick your company, and approve.
   The script stores QuickBooks' refresh token and renews it automatically.
   If it's unused for 100 days, run `authorizeQuickBooks` again.

### 5. Map accounts
1. In QuickBooks, create any accounts you don't have yet. Suggested:
   - `Sales Tax Payable - Toast`: Other Current Liability. Use your own
     liability account. QuickBooks' automated sales-tax account can't take
     direct postings. Pay your Department of Revenue from this account.
   - `Tips Payable`: Other Current Liability. It is cleared when payroll pays
     tips out.
   - `Toast Capital Loan`: Other Current Liability (or Long Term).
   - `Toast Equipment Lease`: liability or expense, per your accountant.
   - `Toast Checking`: Bank, if you use a Toast checking sweep.
   - `Toast Withholdings - Unallocated` and `Toast Reconciliation Differences`:
     both should normally stay at $0.
2. Edit the `CONFIG` block (accounts, per-location Location/Class, withholding
   rules, payout splits).
3. Run **`checkSetup`**. It lists every Toast location with its GUID and
   confirms every account name exists in QuickBooks. Fix anything it lists.

### 6. Dry run, compare, go live
1. Run **`previewYesterday`**. The log and email show each Deposit that
   *would* be created for the most recent payout day. Compare it against
   Toast's Payout Details report and your bank statement.
2. Add Script Properties `START_DATE` (first settled date to post, YYYYMMDD)
   and `SYNC_MODE` = `live`.
3. Optional catch-up: edit the dates in `backfill()` and run it. It stops after
   ~4.5 minutes to stay under Google's 6-minute limit; run it again until it
   reports nothing left.
4. Run **`installDailyTrigger`**. Done.

### 7. Turn off the old job
The old job that writes empty `payouts-*.json` files to the "Stacks Toast
Payouts" folder (every day around 16:30 UTC) is no longer needed. Find it under
**Triggers** in its Apps Script project (or wherever it was set up), and delete
the trigger. To keep a JSON audit trail, set `CONFIG.sync.auditFolderId` to
that folder's ID. This script then writes one `qbo-posted-…json` per payout.

## Day to day
- When QuickBooks downloads the Toast deposit from your bank, the bank feed
  shows it as a **match** for the Deposit this script created. Click **Match**,
  or select all and batch-accept. QuickBooks does not allow software to accept
  bank-feed matches for you.
- You get an email only when something posted (if `sendDailySummary`) or needs
  attention. "[ACTION]" emails list exactly which payout and why.

## Development
```
npm test        # rebuilds dist/Code.gs, then runs the unit tests (Node 18+, no dependencies)
```
`src/` is plain Apps Script (one shared global scope). `test/harness.js`
loads it into a Node VM with fake Toast/QuickBooks HTTP.
