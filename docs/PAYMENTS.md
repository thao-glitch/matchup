# Accepting payments through your DTB paybill

Matchup takes money the Kenyan way: **paybill first, everything else later**.
There is no card form and no redirect in the app — a visitor pays into your
Diamond Trust Bank paybill from their own bank app or M-PESA, and the app
matches that payment back to their account using a unique **Account Number**.

This guide covers the two halves: what to ask DTB for, and how the app is
wired to it.

---

## 1. What DTB actually issues

DTB does not sell a "paybill" as a standalone product — it is issued against a
business account, and how automated you can get depends on which collection
product you attach to it.

| What you ask DTB for | What you get | Automation |
| --- | --- | --- |
| **DTB business account** (Classic Business Current) | A 10-digit account number you own | — |
| **Lipa na M-PESA / Paybill collections on 516600** | Payers send to **Paybill 516600** and quote *your* short code / account number as the Account Number | Manual — you read the notification or statement |
| **Till Moja** (collections service) | Instant credit notifications into the account for mobile-money collections | SMS/e-mail advices + portal |
| **InfinitiLite** (merchant collections portal) | Merchant management, transaction reports, reconciliation | Semi-automated portal |
| **DTB i24/7 internet banking** | Real-time statement, e-mail/SMS payment advices, bulk reports | The statement is what you reconcile against |
| **DTB Astra (API Banking)** | REST APIs for payment status, statements, account data | Fully automated callback / polling |

**Paybill 516600 is DTB's shared collection number.** Your customers pay into
`516600` and put *your* identifier in the Account Number field — either your
10-digit DTB account number, or the merchant **Short Code** DTB assigns you
when you onboard for collections. Which one you use is decided when you open
the product; ask the branch explicitly: *"I want a collection short code on
516600 that passes the payer's Account Number reference through to my
statement."* That single sentence is what makes the app's automatic matching
work.

> Contact DTB on **0719 031 888** or `contactcentre@dtbafrica.com`, or walk
> into any branch with your KRA PIN, business registration and ID. Verify any
> link you are asked to log into directly with the bank — never through a
> search result.

---

## 2. The three ways to receive a payment into the app

### Option A — Manual reconciliation (what this app does out of the box)

Zero agreements, works on day one:

1. The visitor presses **Pay by paybill** in the lobby. The app shows:
   - **Paybill:** `516600` (or whatever you configured)
   - **Account Number:** their unique reference, e.g. `MU1042`
   - **Amount:** whatever you set (e.g. KES 500)
2. They pay from any bank app / M-PESA (`Paybill → 516600 → MU1042 → 500 → PIN`).
3. They press **I have paid**, optionally pasting the M-PESA transaction code.
4. You open **`/admin` → Payments**, look at the pending row, check your DTB
   i24/7 statement (or the M-PESA SMS) for `MU1042`, and press **Approve**.

Approval stamps 30 days of premium on that account. The whole step takes about
five seconds once the money is visible on the statement.

### Option B — Statement upload / copy-paste reconciliation

Same as Option A, but instead of eyeballing each payment you download the day's
statement from i24/7 and check the batch. The ledger in `/admin` is sorted so a
day's pending rows can be ticked off in one sitting.

### Option C — Automated (DTB Astra / Till Moja / InfinitiLite)

Ask DTB for **API Banking (Astra)** access and they give you credentials for
their collection/status endpoints. Wiring that into Matchup means adding a
small webhook/poller that calls `PATCH /api/admin/payments/:id` with
`{"status":"approved"}` — the same call the dashboard button makes, so nothing
else in the app changes. Until DTB issues API credentials, Option A is the
normal Kenyan setup and is what most SMEs run.

---

## 3. Configuring the app

Everything below is edited in the dashboard — **`/admin` → Settings** — and
takes effect immediately for every visitor. No redeploy, no code change.

| Setting | Example | What it does |
| --- | --- | --- |
| **Enabled** | on | Master switch for the whole payment panel |
| **Bank** | `Diamond Trust Bank (DTB)` | Shown next to the price |
| **Paybill** | `516600` | The number the payer selects |
| **Account number format** | `MU{id}` | The unique reference per user. `{id}` = their account id, `{username}` = their username. Keep it short and alphanumeric — M-PESA truncates long references |
| **Price** | `500` | KES charged per period |
| **Premium days** | `30` | Days granted when a payment is approved |
| **Instructions** | free text | Rendered under the paybill block |
| **Support contact** | `07xx xxx xxx` | Shown when a payment is rejected |

**Which account-number format to pick.** The value has to (a) fit in the
Account Number field of the payer's app — 1–13 characters is safe — and (b) be
unique per user. `MU{id}` gives `MU1042`, `MU77`, `MU1204`: unique, short,
case-insensitive-proof. If DTB gives you a numeric-only short code, use
`{id}` alone.

> Changing the format does not break anything: any *pending* payment's
> reference is rewritten to the new format the next time that user opens the
> panel. Already-approved payments keep the reference they were paid with.

---

## 4. Daily routine (the two-minute version)

1. Open DTB i24/7 (or the M-PESA confirmation SMS batch) for the day.
2. Open `https://<your-app>/admin` → **Payments** → *Pending*.
3. Match the Account Number column against the statement row.
4. **Approve** (grants premium) or **Reject** (with a note the user sees).

Every action is written to the **Audit** tab with your admin name, the amount
and the transaction code — so a disputed payment can always be traced.

---

## 5. Fees, taxes and compliance — the honest list

- **M-PESA/transact fees** on 516600 are charged by DTB per collection; check
  the current tariff with the bank (they revise it).
- Money collected through a business account is business revenue: keep the
  statement, and file it with your KRA obligations (a KRA PIN for the business
  is required to open the account anyway).
- If you later outgrow manual reconciliation, DTA/Astra API access is the
  upgrade path — nothing in the app has to change.

---

## 6. Testing before you announce it

1. Set a small price in `/admin` → Settings (e.g. `50`).
2. Pay it yourself from your own phone: `516600` → your format → amount.
3. Press **I have paid**, paste the real transaction code.
4. Approve it in `/admin` → **Payments**.
5. Reload the lobby: the panel must read *Premium active until …*.
6. Set the real price afterwards.

An approved payment never expires early — approving the same row twice does
**not** extend the premium twice; re-approving is a no-op by design.

---

## 7. If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Payer's reference is missing from the statement | DTB credited by account number only | Ask DTB to enable "pass through account/reference" on the collection code |
| Payment arrived but the row is missing | The payer never pressed **I have paid** | Approve manually from `/admin` once you know the account number, or ask them to press it |
| Wrong premium length granted | Settings changed after the intent was created | The payment row stores its own `premiumDays` — approve, then adjust the user from `/admin` → Users |
| Panel says payments disabled | `Enabled` or the premium feature is off in Settings | Switch it back on |
