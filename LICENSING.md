# Licence keys

How somebody who pays for Companion Pro gets a working app.

```
  Stripe Payment Link
        |  payment clears
        v
  POST /api/stripe/webhook  ---> mints PCT-XXXXX-XXXXX-XXXXX-XXXXX
        |                        stores it in KV
        |                        emails key + download link (Resend)
        |
        +--> buyer is redirected to /pro-tool/download/?session_id=cs_...
        |    which polls /api/license/session and shows the key immediately
        v
  buyer pastes the key into the app
        |
        v
  POST /api/license/activate  ---> a signed Ed25519 token, expiry =
                                   paid period + 7 days
        |
        v
  the app verifies that token offline, for ever, with no network
```

## Why it is built this way

**Two strings, two jobs.** The *key* is short and human: it means nothing on
its own, it is only a lookup in KV, and it is what the buyer keeps. The *token*
is what the app actually trusts — a small signed payload it can check offline
against a public key baked into the build.

**Revocation without a kill switch.** A token's expiry is the end of the paid
period plus a week of grace. While the subscription is live the app quietly
re-activates and the expiry moves forward. Cancel, and nothing is re-issued:
the last token lapses on its own. Nothing ever has to reach the user's machine
to take Pro away, which means no phone-home requirement and no lockout when the
server is down or they are on a plane.

**One build.** There is no separate Free download and Pro download any more.
`release.py` produces a single app; `edition.py` asks `licensing.py` at startup
what it is allowed to do. A buyer never fetches a second 400 MB file.

**What this does not do.** It does not stop a determined person patching the
binary. Public-key verification means only *you* can mint keys, so one leaked
key cannot become a key generator. That is the realistic goal; anything more
costs honest users more than it costs the dishonest ones.

## Switching it on

### 1. Make the signing keypair

```bash
node tools/make-license-keypair.mjs
```

It prints the **public** key and writes the **private** key to
`../.license-private-key.txt` (mode 0600) — one level above this folder, on
purpose. `pages_build_output_dir` is `.`, so anything sitting in this directory
is a candidate for public upload, dotfiles included. It refuses to overwrite an
existing file. Keep a backup somewhere safe: losing it means every existing
licence stops being renewable.

Put the printed public key into `pokemon_champions_tool/licensing.py`:

```python
LICENSE_PUBLIC_KEY = "...the printed value..."
```

That value is safe to ship: it can only verify, never sign.

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create LICENSES
```

Copy the id it prints into `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Load the secrets

Each of these is entered interactively; none of them belongs in a file in this
repo.

```bash
npx wrangler pages secret put LICENSE_PRIVATE_KEY
npx wrangler pages secret put STRIPE_SECRET_KEY
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET
npx wrangler pages secret put RESEND_API_KEY
npx wrangler pages secret put LICENSE_FROM_EMAIL
```

| Secret | Where it comes from |
| --- | --- |
| `LICENSE_PRIVATE_KEY` | the base64 line in `.license-private-key.txt` |
| `STRIPE_SECRET_KEY` | Stripe dashboard, Developers → API keys (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | shown when you create the webhook endpoint (`whsec_...`) |
| `RESEND_API_KEY` | Resend dashboard, API Keys (`re_...`) |
| `LICENSE_FROM_EMAIL` | e.g. `Champions Battle Data <keys@championsbattledata.com>` |

`DOWNLOAD_URL` is optional and defaults to
`https://championsbattledata.com/pro-tool/download/`.

### 4. Point Stripe at the webhook

Stripe dashboard → Developers → Webhooks → Add endpoint:

* **URL** `https://championsbattledata.com/api/stripe/webhook`
* **Events**
  * `checkout.session.completed` — a new purchase
  * `invoice.paid` — a renewal
  * `customer.subscription.updated` — past_due, unpaid, resumed
  * `customer.subscription.deleted` — cancelled
  * `charge.refunded` — refunded

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 5. Set the Payment Link redirect

On **both** Payment Links (monthly and yearly), under *After payment*, choose
"Don't show confirmation page → Redirect to your website" and enter:

```
https://championsbattledata.com/pro-tool/download/
```

Tick the option to append the session id. The success page uses it to show the
key straight away; without it the page still works and simply points at the
email.

### 6. Verify the sending domain in Resend

Add `championsbattledata.com` in Resend and publish the DKIM and SPF records it
asks for. Until the domain is verified, keys will be minted and stored but the
emails will not arrive — the buyer would still see the key on the success page,
but they would have no copy.

### 7. Release the app

```bash
python release.py --version 1.0.0 --upload
```

One build, uploaded as a versioned zip, a stable
`PokemonChampionsTool-latest.zip` for the website, and `latest.json` for the
in-app updater.

## Checking it works

Use Stripe **test mode** first: test keys, a test Payment Link, a test webhook
endpoint, and card `4242 4242 4242 4242`. A test purchase should give you a key
on the success page within a few seconds and an email shortly after.

To exercise the whole chain without Stripe at all, the harness in
`tools/` territory is not needed — the Functions are plain modules, so a Node
script can import them with a fake `env` and an in-memory KV. That is how the
current implementation was verified: webhook signature rejection, key minting,
retry de-duplication, the success-page lookup, activation, cancellation, and
the resend endpoint not revealing who has a subscription.

## Day to day

**Someone lost their key.** Send them to
`https://championsbattledata.com/pro-tool/key/`. It emails the key to the
address on the subscription and gives the same answer whether or not that
address has one.

**Someone needs a key by hand** (a refund gone wrong, a gift, a moderator):

```bash
npx wrangler kv key put --binding LICENSES "licence:PCT-AAAAA-BBBBB-CCCCC-DDDDD" \
  '{"key":"PCT-AAAAA-BBBBB-CCCCC-DDDDD","email":"them@example.com","plan":"yearly","status":"active","periodEnd":4102444800}' --remote
```

A `periodEnd` far in the future is effectively a permanent licence.

**Someone is abusing a key.** Set `"status":"revoked"` on their record. They
keep Pro until their current token expires (at most the grace period), then
drop back to free.

**Checking on a licence:**

```bash
npx wrangler kv key get --binding LICENSES "licence:PCT-..." --remote
npx wrangler kv key get --binding LICENSES "email:them@example.com" --remote
```

## The pieces

| File | What it does |
| --- | --- |
| `functions/api/stripe/webhook.js` | Stripe events → keys, emails, status changes |
| `functions/api/license/activate.js` | key → signed token |
| `functions/api/license/session.js` | checkout session → key, for the success page |
| `functions/api/license/resend.js` | email → send the key again |
| `functions/api/license/_lib.js` | key format, token minting, KV records |
| `tools/make-license-keypair.mjs` | one-time keypair generation |
| `pro-tool/download/` | the post-purchase page |
| `pro-tool/key/` | the lost-key page |
| `../../pct_tool94/pokemon_champions_tool/licensing.py` | app side: verify, store, activate, refresh |
| `../../pct_tool94/pokemon_champions_tool/_ed25519.py` | dependency-free Ed25519 verification |
| `../../pct_tool94/pokemon_champions_tool/edition.py` | resolves the tier from the licence |

## KV layout

| Key | Value |
| --- | --- |
| `licence:PCT-...` | the record: key, email, plan, status, periodEnd, Stripe ids |
| `email:someone@example.com` | their licence key, so resend works without a scan |
| `session:cs_...` | the key minted for that checkout, also the retry guard |
| `sub:sub_...` | the key for a Stripe subscription, for renewal events |
| `resend:someone@example.com` | a short-lived cooldown marker |
