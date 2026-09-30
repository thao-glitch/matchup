# Ads — earning from visitors *and* buying growth

Two separate things live here:

1. **Ads in the app** — banners shown to your visitors, you get paid per view/click.
2. **Ad campaigns promoting Matchup** — you pay to put the app in front of
   people in Europe who will actually use it.

Both need the same foundation: the **Privacy Policy** and **Terms** pages now
built into the client (`#privacy` / `#terms`, linked in the lobby footer).
No ad network and no ad platform approves a site without them.

---

## Part 1 — Ads inside the app

### Where ads appear

One banner slot in the lobby, under the form (`client/src/components/AdSlot.tsx`).
**Never during a call** — it would hurt the product and every network
restricts disruptive placements anyway. The slot renders *nothing* unless the
build carries ad variables, so localhost, tests and pre-approval deployments
are always ad-free.

### Option A — Google AdSense (best rates, strict approval)

1. Apply at **https://adsense.google.com** with `matchup-mu.vercel.app`
   (Google account → "Get started" → enter your site).
2. Google reviews content, navigation, policy pages and **your own traffic
   behaviour**; expect 1–4 weeks and know that 18+ random-video-chat sites are
   frequently rejected the first time. Apply anyway (it's free), and appeal
   with improvements if rejected — approval also unlocks YouTube-style
   placements later.
3. Once approved you get a publisher id (`ca-pub-XXXXXXXXXXXXXXXX`) and a
   slot id per ad unit (AdSense → **Ads → By ad unit → Display ad**).
4. Put both into the client and redeploy:

   ```bash
   cd client
   echo "ca-pub-XXXXXXXXXXXXXXXX" | npx vercel env add VITE_ADSENSE_CLIENT production
   echo "1234567890"              | npx vercel env add VITE_ADSENSE_SLOT   production
   npx vercel --prod
   ```

5. Verify: the deployed lobby contains `<ins class="adsbygoogle" …>` and ads
   fill within a minute (ads can show "not active" for a day right after
   approval — that's normal).

**EU visitors & consent:** personalised ads in the EU/UK require consent.
Before turning AdSense on for European traffic, add a consent banner — Google
[Funding Choices](https://support.google.com/admanager/answer/9424066) or a
free CMP (Cookiebot free tier, Termly, Ketch) — and wire it into the Privacy
Policy's advertising section. Unconsented traffic still sees non-personalised
ads at a lower RPM.

### Option B — alternatives if AdSense rejects you (or alongside it)

These networks accept brand-new sites, approve within hours–days, and pay
less (roughly $0.30–1.50 RPM for social/chat traffic vs AdSense's $1–5 in
Europe):

| Network | Why consider it | Format |
| --- | --- | --- |
| [Adsterra](https://adsterra.com) | fast approval, self-serve, social-bar/banner | banner, floating social bar |
| [Monetag](https://monetag.com) | same owner as PropellerAds, very beginner-friendly | banner, push, onClick |
| [PropellerAds](https://propellerads.com) | veteran, accepts almost anything legal | banner, interstitial,OnClick |
| [HilltopAds](https://hilltopads.com) | chat/streaming-friendly | banner, popup |

Integration: each gives you a **`<script>` snippet** — paste it once into
`client/index.html` before `</body>`. It renders on every page; place your
first unit **below the lobby form only** (not over the video call). Re-test
`npm run test:e2e` afterwards: a network's injected DOM must never overlap
the buttons the tests click.

### What to expect to earn

| Monthly users | Network | Rough revenue |
| --- | --- | --- |
| 10k pageviews | Adsterra/Monetag | $5–15 |
| 10k pageviews | AdSense (EU traffic) | $10–50 |
| 100k pageviews | AdSense | $100–500 |

Banner ads on a utility site make **pocket money, not a living** — their real
second job is funding the campaigns below.

### Ad hygiene rules (keep these)

- One placement, below content, never covering the camera/mic buttons.
- No pop-ups/interstitials on first visit — they wreck retention *and*
  AdSense policy.
- Ads must not be the reason the lobby is slow: the loader is async and the
  slot renders empty until the script arrives.
- Re-run `npm run test:e2e` (37/37 must stay 37/37) after any ad change.

---

## Part 2 — Campaigns to promote Matchup

### Before spending €1 of ad money (30 min checklist)

- [ ] `https://matchup-mu.vercel.app` loads, `/health` is green (cloud setup
      from `DEPLOY.md` — ads pointing at a broken app is money burned).
- [ ] Privacy + Terms open from the footer; on the **same domain** as the ad
      lands (platforms check this).
- [ ] Decide what a "good user" is: **pressed Start and got matched.** Install
      a lightweight analytics so you can see it: Plausible/Umami (cookieless,
      EU-friendly) or GA4 — paste into `client/index.html`, then track the
      event `match_started` (one line: `navigator.sendBeacon` or push to
      `window.plausible`/`gtag` inside `start()` in `App.tsx`).
- [ ] Prepare 3 creatives (see below) *before* opening any ad account.

### Channel 1 — Organic first (€0 — do this before paying anything)

For a brand-new social product, organic beats paid for the first month:

1. **TikTok / Instagram Reels / YouTube Shorts**: 15–30 s screen recordings
   of real matching moments ("matched with someone from 🇩🇪 in 8 seconds"),
   text overlay hook → "link in bio". Post daily for 2 weeks; this category
   (omegle-successor / random video chat) gets pushed hard by the algorithm.
2. **Language-learning & Erasmus communities**: r/languageexchange,
   r/erasmus, r/socialskills, Erasmus Facebook groups, university Discords —
   frame Matchup as *practice a language with a native speaker* (this is the
   angle that also survives ad-platform review).
3. **Product directories**: Product Hunt, BetaList, AlternativeTo ("Omegle
   alternatives" is a huge search intent since Omegle shut down).
4. **Your own post-call share card** is already built — every shared card is
   free distribution; make sure it renders well (it does).

### Channel 2 — Meta ads (Facebook/Instagram), where Europe's 18–34 is

1. **Business Manager**: business.facebook.com → create business account →
   add a payment method (this is where money starts leaving).
2. **Pixel/CAPI**: Meta Events Manager → create pixel → paste the base code
   into `client/index.html`. Track `ViewContent` (landing) and a custom
   `MatchStarted`.
3. **Campaign structure** (start here, don't over-build):
   - Objective: **Traffic** first (cheap data), later **Conversions** once
     ~50 matches/week exist.
   - One ad set, **Advantage+ audience** off, manual: locations `Europe`
     (or 5 launch countries: DE, FR, ES, IT, NL), age `18–34`, all genders.
     Interests: *language learning, Erasmus, travelling, making friends,
     Meetup, tandem language exchange*. Exclude people who already converted.
   - Budget **€5/day**, Learning phase needs ~50 conversions — give it 5–7
     days before judging.
4. **Creative rules for this category** — Meta rejects anything resembling
   "adult content" or dating-implies-sexual vibes:
   - Show the **interface**, not skin: two phones side by side, flags, chat
     bubbles, "match in 8s".
   - No half-naked people, no "hot singles" framing, no before/after
     attractiveness content → instant rejection + account restriction.
   - First 3 seconds carry the hook: "Talk to a stranger from Europe —
     camera on, 8 seconds, no signup."
5. **Landing**: homepage itself. It already has policy pages, a clear value
   prop and one CTA ("Start"). Don't build a separate landing yet.

### Channel 3 — Google Search (capture existing intent)

1. ads.google.com → campaign → **Search**, goal "Website traffic",
   bid strategy **Maximize clicks** with a €5/day budget cap.
2. Target keywords people already type:
   - `random video chat`, `omegle alternative`, `video chat with strangers`
   - `practice english with natives free`, `language exchange video call`
   - `meet people abroad`, `chatroulette alternative europe`
   - Phrase/exact match; add `free` and `no signup` as positives, exclude
     `kids`, `under 18`, `porn`, `nude` (negative keywords — critical).
3. Location: same 5 countries; language: English + local.
4. Sample ad copy:

   > **Talk to Someone New Tonight** · Matchup — 1-on-1 video chat, matched in
   > seconds. No signup, works on any phone. Try it free →

### Channel 4 — TikTok Ads (fastest cheap reach for this demo)

- Objective: **Traffic** or **Video Views**; daily budget €5–10; age 18–34;
  geo Europe; placements = in-feed.
- Creative = the organic format, lightly boosted; TikTok rejects suggestive
  creatives even harder than Meta — screen-recordings of the app are safest.
- Run only after organic posts prove which hook works (best organic post →
  boost it, don't guess).

### Budget & measurement (keep it boring and small)

| Week | Spend | Where |
| --- | --- | --- |
| 1–2 | €0 | Organic only + analytics + creatives |
| 3–4 | €35 (€5/day) | Meta test — one audience, 3 creatives |
| 5 | €35 | Google Search test (same budget) |
| 6+ | scale the winner | +50% budget on the channel with cheapest **per matched user**, kill the other |

**KPIs to watch weekly** (from analytics + the app's own `/health` presence):

- Cost per landing visit: target **< €0.15**.
- Landing → Start rate: **> 20 %** (below 10 % = fix the landing/creative).
- Cost per matched user: the only number that truly matters; aim **< €0.50**.
- Returning users (localStorage token reuse) — growth that sticks.

### Things that will get you banned (don't)

- Buying followers/likes/bot traffic — platforms and ad networks detect it.
- Misleading creatives ("girls are waiting", fake chat screenshots) — Meta
  and Google restrict accounts on first offense, permanently on the second.
- Running ads without the Privacy Policy reachable from the landing page.
- Targeting or permitting under-18 anywhere — the product is 18+; wrong-age
  traffic is both a policy violation and worthless to you.

---

## Quick reference — current integration points

| What | Where |
| --- | --- |
| Ad slot component | `client/src/components/AdSlot.tsx` |
| Ad variables | Vercel → `VITE_ADSENSE_CLIENT`, `VITE_ADSENSE_SLOT` |
| Other networks' snippet | `client/index.html` before `</body>` |
| Privacy / Terms | `client/src/components/LegalPage.tsx` (`#privacy`, `#terms`) |
| Analytics / pixel | `client/index.html` (same place) |
| Consent banner (EU) | add with AdSense; see "EU visitors & consent" |
| Test guard after any ad change | `npm run test:e2e` → must stay 37/37 |
