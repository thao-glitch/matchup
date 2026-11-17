# Accepting payments: M-PESA STK push, straight to your number

Matchup takes money the Kenyan way, but it does not wait for a bank
statement. A visitor enters their M-PESA number, their phone prompts them for
the PIN, and the moment they confirm, Safaricom's callback settles the charge
and premium switches on. There is no card form, no redirect, no account
number to copy and nothing for you to approve by hand.

This guide covers both halves: what you need from Safaricom, and how the app
is wired to it.

---

## 1. The one thing to understand first

**STK push bills against a shortcode, not against a bare phone number.**
Daraja's `/mpesa/stkpush/v1/processrequest` requires a `BusinessShortCode`
in the request. Without one Safaricom rejects it outright — that is not a
Matchup limitation, it is how Lipa na M-PESA Online works.

Here is the part that matters for you: **you do not need a business bank
account for the money to reach your own phone.** The flow is:

```
buyer's phone  ──PIN──▶  your shortcode's collection account  ──settlement──▶  your M-PESA number
```

The shortcode is only the collection point. You tell Safaricom to get its
balance onto a number you choose, and that number is yours — the same personal
M-PESA line you use every day. That last hop is configured on Safaricom's side,
not in this codebase, and it is the step that makes "my number receives the
cash" true.

So what you need from Safaricom is:

| What | Why | Roughly |
| --- | --- | --- |
| A **Paybill** *or* **Buy Goods till** number | It is the `BusinessShortCode` every STK push bills against | Applying is free |
| Its **balance settled to your M-PESA number** | So the collected money lands on your line, not in a bank | Set on registration (paybill) / withdrawn from the shortcode (till) |
| A **Lipa na M-PESA Online passkey** | Signs the request — long string, issued with the shortcode, not your account password | Issued with the shortcode |
| **Consumer key + secret** | The Daraja app credentials that fetch the OAuth token | Free, from the Daraja portal |

**Paybill or till?** STK push supports both, but the request has to name the
rail: `CustomerPayBillOnline` bills a Paybill, `CustomerBuyGoodsOnline` bills a
Buy Goods till, and Safaricom rejects a mismatch. Tell the app which one you
hold under **Settings → M-PESA → Shortcode type** (it defaults to Paybill).

If you are applying from scratch, the **till is the easier one to get**: an
individual can apply without a registered company (national ID + KRA PIN; a
county business permit is often asked for too), it is free, and it is usually
issued within about a day. Apply at **hub.m-pesaforbusiness.co.ke** → *Apply for
a Paybill or Till*, or walk into a Safaricom Shop with the Lipa na M-PESA form.
Money collects on the till and you withdraw it to your own M-PESA number from
there. A **Paybill** needs fuller business KYC and settles its balance to your
number on Safaricom's side — either way the cash ends on your personal line.

> If you have no shortcode yet, everything still works against the Daraja
> **sandbox** (`174379` + the sandbox passkey) so you can finish wiring and
> testing the app. Real money needs the production shortcode.

---

## 2. Manual review mode — for when there is no Daraja at all

Some owners don't have a Paybill or Till (and the Pochi la Biashara they do
have is not supported by STK push — it is a manual product only). Until you
do, the app runs a **manual payment review** instead of firing a PIN prompt:

1. Turn on **`/admin` → Settings → Manual payments → Manual payment review**.
   Set the **destination** (e.g. your Pochi number) and the short instructions
   shown to every buyer. Off → the app is exactly as described above.
2. A buyer presses Pay: no PIN prompt appears on their phone. Instead the
   screen shows them the amount, the exact number to send it to, their own
   phone number and a reference. They send the money any way M-PESA allows
   (Pochi, pay-someone, Airtel Money — whatever reaches the destination).
   Every paid post is timed: the creator picks the window (15 min → 24 h) when
   they publish, and a purchase grants exactly that window — nothing is ever
   "forever". The window renews by buying again, extended from the later of
   now or the existing expiry.
3. The purchase appears in **`/admin` → Earnings → Charges** as **pending**,
   with the buyer's phone number, the amount, and the purpose (`post` /
   `room` / `sub` / `premium`) — enough to match the SMS.
4. **You approve it** (or reject it). Approval calls the same `settle()` the
   STK callback would — the platform cut is taken, the creator's wallet is
   credited with the net, and the buyer gets whatever they bought (post
   unlocked / room entered / subscription activated / premium). Rejecting
   marks it failed and the buyer gets nothing. All of it is audited in
   `/admin` → Audit.
5. **Payouts behave the same as before**: a creator requests a withdrawal in
   `/wallet`, it lands in **Earnings → Payout requests** as pending; you send
   the money by M-PESA (Pochi: *Move money → Send money*) and approve the
   request (or reject to refund it to their in-app wallet).

Honest limits: **nothing is automatic** — every payment and every payout
needs your eye and a tap. It does not scale past a handful of transactions a
day, it relies on you matching SMS by phone + amount, and buyers cannot have
a guaranteed-instant purchase. The moment you have Daraja credentials, turn
the toggle off and switch to STK push — no data migration, no redeploy.

## 3. How the app is wired

One table, `charges`, holds every payment on the platform — premium, post
purchases and room entry alike:

1. **The row is written first**, then the STK push is fired. The
   `CheckoutRequestID` is written onto the row immediately after, and it is
   unique-indexed, so a callback arriving in the same millisecond still finds
   its row.
2. **Their phone prompts for the PIN.** They confirm, and Safaricom POSTs to
   `POST /api/mpesa/callback`.
3. **`settle()` flips `pending → paid`.** That UPDATE carries a
   `WHERE status = 'pending'`, so the callback, a status poll and a manual
   dashboard click can all race it and exactly one of them wins — nobody is
   ever charged twice, and nobody is ever granted premium twice.
4. **Polling is the safety net.** Callbacks get lost (firewalls, restarts,
   tunnel changes), so while the charge is pending the client polls it and
   the server asks Daraja's query endpoint directly after giving the callback
   a six-second head start. Three independent ways to reach `paid`.

For a premium charge, settling stamps `premium_until` on the **buyer** — they
bought time, not credit, so no creator wallet is touched.

The period is stamped onto the charge row when it is opened, so editing the
price or the premium length in Settings later cannot change what someone was
already prompted for.

---

## 4. Configuring the app

Everything below is edited in **`/admin` → Settings** and takes effect
immediately for every visitor. No redeploy, no code change.

**Premium subscription** — the price, the number of days granted, the product
name on the button, and the wording shown under it.

**M-PESA (Daraja)**

| Setting | Example | What it does |
| --- | --- | --- |
| **Consumer key / secret** | from the Daraja portal | Fetch the OAuth token. Masked on read; saving without retyping keeps the stored value |
| **Shortcode** | your Paybill or till number | The `BusinessShortCode` every push bills against |
| **Shortcode type** | `Paybill` or `Buy Goods till` | Picks `CustomerPayBillOnline` vs `CustomerBuyGoodsOnline`. Must match the shortcode you entered, or Safaricom rejects every prompt |
| **Passkey** | the Lipa na M-PESA Online passkey | Signs the request. This is *not* your account password |
| **Base URL** | `https://api.safaricom.co.ke` | `https://sandbox.safaricom.co.ke` while testing |
| **Callback URL** | `https://<your-host>/api/mpesa/callback` | Must be public **https** — Safaricom refuses plain http and cannot reach localhost |

**Callback URL is the field people get wrong.** Safaricom has to be able to
reach it from the public internet. If your app is behind a tunnel, put the
tunnel's https URL there. Without a reachable callback, verification falls
back to polling, which works but is slower.

---

## 5. Testing before you announce it

`/admin` → Settings → **M-PESA** has a **Test connection** button. It reports
one line per requirement — credentials, shortcode, passkey, callback,
whether Safaricom issued a token — so you can tell "my key is wrong" apart
from "my shortcode is missing" without reading a stack trace.

Give it a phone number and it fires a **real KES 1 STK prompt** at that
number. That is the only honest end-to-end proof: Safaricom validates the
shortcode and passkey when it builds the prompt, so nothing upstream of it
can lie to you. A real KES 1 is actually charged, which is a cheap price for
knowing it works.

Then run the full loop:

1. Set a small price in Settings (e.g. `50`).
2. Press **Pay with M-PESA** in the lobby from your own phone.
3. Enter your PIN. The panel must flip to *Premium active* within a few
   seconds, without you touching the dashboard.
4. Check `/admin` → **Earnings** — the charge is there, marked paid, with its
   M-PESA receipt.
5. Set the real price afterwards.

---

## 6. Fees, taxes and compliance

- **Transaction fees** apply per collection; check the current tariff with
  Safaricom, they revise it.
- Money collected through your shortcode is your revenue. Keep the M-PESA
  statements — they are what you file against your KRA obligations.
- Getting that money onto your own number is a Safaricom configuration —
  settlement for a paybill, a withdrawal for a till. It does not change
  anything in this app.

---

## 7. If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| *"M-PESA cannot take a payment yet — the shortcode is still missing"* | No `BusinessShortCode` configured | Add your Paybill or till number in Settings. STK push cannot run without one |
| *"M-PESA rejected the credentials"* | Consumer key/secret wrong or expired | Re-copy them from the Daraja portal, save, then **Test connection** |
| The prompt never arrives on the phone | Wrong shortcode or passkey — Safaricom refuses the request silently on the buyer's side | **Test connection** with your own number; it reports the exact refusal |
| Same, and the refusal names the transaction type | **Shortcode type** does not match the shortcode (paybill set against a till, or the reverse) | Set *Settings → M-PESA → Shortcode type* to the rail your number actually is |
| The prompt arrives, they pay, but the panel stays pending | The callback URL is not reachable from the public internet | Fix the URL in Settings (https, public host). The poll will still settle it — just slower |
| *"That payment does not exist"* when polling | The charge expired — STK requests die after 5 minutes | Press pay again |
| Wrong premium length | — | The charge stores its own `premiumDays`. Adjust the user from `/admin` → Users if a past charge was mispriced |
| Panel says M-PESA is not accepting payments | The premium switch, or Daraja readiness, is off | Switch premium on in Settings and complete the M-PESA block |

A charge whose callback never arrived can still be settled by hand from
`/admin` → **Earnings**. `settle()` is idempotent, so clicking it cannot
double-grant premium even if the callback shows up a second later.
