# Razorpay UPI Payment Telegram Bot

A **production-ready, fully customizable** Telegram bot to collect UPI payments via Razorpay QR codes — with sandbox and live modes, instant payment detection via webhooks, and zero coding required for most use cases.

Built with **Node.js 20 + TypeScript + grammY + Razorpay SDK + Express**.

> **Open source & customizable** — configure everything via env vars, or fork and extend the code for your specific use case.

---

## Demo

```
User:  /start

Bot:   👋 Ravi's Store
       🏷️ Consultation Call
       💰 Accepts: ₹1.00 – ₹1,00,000.00

       Commands
       🧪 /test — Sandbox (safe to try, no real money)
       🔴 /real — Pay with UPI (real money)
       ❓ /help — How to use this bot

       Try it: Send /test — use UPI ID success@razorpay to simulate a payment.

─────────────────────────────

User:  /real

Bot:   ⚠️ LIVE MODE — real UPI money will move
       ━━━━━━━━━━━━━━━━

       💸 Range: ₹1.00 – ₹1,00,000.00

       How much ₹? (e.g. 500 or 1500.50)
       Or /cancel to abort.

User:  500

Bot:   ⚙️ Generating live UPI QR for ₹500.00...
       [QR Image sent]
       🔴 LIVE  ·  ₹500.00
       ━━━━━━━━━━━━━━━━
       💰 Pay exactly: ₹500.00
       ⏳ Expires in: 2:00
       📱 Scan → UPI app opens → ₹500.00 auto-filled → just tap Pay
       [🔍 Check Now]  [❌ Cancel]

       (user scans and pays)

Bot:   🎉  PAYMENT SUCCESS!

       💰  ₹500.00
       🔖  Digital Course
       🆔  pay_AbCd1234XxYy
       🔒  Secured by Razorpay
       🔴  Live Mode

       🎉 Access your course: https://course.com/start

       Send /real to make another payment
```

---

## Features

| Feature | Details |
|---|---|
| **Dual mode** | `/test` = sandbox (no real money), `/real` = live UPI |
| **Customizable amount** | User enters any amount — bot generates QR with exact amount pre-filled |
| **Instant detection** | Webhook-first, 1.5s polling fallback |
| **Admin notifications** | `ADMIN_CHAT_ID` — get notified on every payment |
| **Post-payment delivery** | `PAYMENT_SUCCESS_MESSAGE` — send key, link, or instructions after payment |
| **Auto-expiry** | Session + QR both close after configurable timeout (default: 2 min) |
| **Pay on Web** | Test mode: Razorpay hosted checkout via browser link |
| **Telegram command menu** | Commands auto-register in Telegram's "/" menu on startup |
| **Direct UPI QR** | Optional: bypass Razorpay API, generate plain `upi://` QR |
| **Webhook security** | HMAC-SHA256 signature verification on every webhook |
| **Long-polling fallback** | No public URL? Bot works locally via long polling |
| **Fully env-var driven** | Zero code changes needed — configure everything in `.env` |

---

## Table of Contents

- [Quick Start (5 minutes)](#quick-start-5-minutes)
- [All Environment Variables](#all-environment-variables)
- [Step 1 — Create Telegram Bot](#step-1--create-telegram-bot)
- [Step 2 — Razorpay API Keys](#step-2--razorpay-api-keys)
- [Step 3 — Razorpay Webhook](#step-3--razorpay-webhook)
- [Step 4 — Run Locally](#step-4--run-locally)
- [Step 5 — Test the Bot](#step-5--test-the-bot)
- [Bot Commands](#bot-commands)
- [Common Use Cases](#common-use-cases)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Deploy to Production](#deploy-to-production)
- [Extend with Custom Logic](#extend-with-custom-logic)
- [Troubleshooting](#troubleshooting)
- [Open Source on GitHub](#open-source-on-github)
- [Security Notes](#security-notes)

---

## Quick Start (5 minutes)

```bash
# 1. Clone the repo
git clone https://github.com/vishwajeetcoderr-dev/tg-upi-live.git
cd tg-upi-live

# 2. Copy env template
cp .env.example .env

# 3. Fill in the required values in .env:
#    TELEGRAM_BOT_TOKEN=
#    RAZORPAY_KEY_ID=
#    RAZORPAY_KEY_SECRET=
#    BRAND_NAME=
#    PRODUCT_NAME=

# 4. Install and run
pnpm install
pnpm --filter @workspace/api-server run dev

# Bot is live — open it in Telegram and send /test
```

---

## All Environment Variables

Copy `.env.example` → `.env` and fill in your values.

### Required

| Variable | Description |
|---|---|
| `PORT` | HTTP server port — use `8080` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `RAZORPAY_KEY_ID` | Razorpay test Key ID (`rzp_test_...`) |
| `RAZORPAY_KEY_SECRET` | Razorpay test Key Secret |

### Razorpay Live Keys (enables `/real` command)

| Variable | Description |
|---|---|
| `RAZORPAY_LIVE_KEY_ID` | Live Key ID (`rzp_live_...`) — requires KYC |
| `RAZORPAY_LIVE_KEY_SECRET` | Live Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret — required in production |

### Branding

| Variable | Default | Description |
|---|---|---|
| `BRAND_NAME` | `My Store` | Business name — shown in /start, QR, payments |
| `PRODUCT_NAME` | `Payment` | Product/service name — shown in QR and confirmation |
| `BOT_DESCRIPTION` | _(blank)_ | Short tagline shown below brand name in /start |

### Product Delivery

| Variable | Description |
|---|---|
| `PAYMENT_SUCCESS_MESSAGE` | Message sent after payment. Placeholders: `{amount}` `{payment_id}` `{mode}`. Deliver product here. |

### Admin & Support

| Variable | Description |
|---|---|
| `ADMIN_CHAT_ID` | Your Telegram chat ID — get from @userinfobot. Notified on every payment. |
| `SUPPORT_CONTACT` | Shown in /help — e.g. `@YourUsername` or `https://wa.me/91XXXXXXXXXX` |
| `GITHUB_URL` | Shown in /about — link to your GitHub repo |

### Feature Flags

| Variable | Default | Description |
|---|---|---|
| `DISABLE_TEST_MODE` | `false` | Set `true` to hide /test (production only mode) |

### Amount Limits (paise — 100 paise = ₹1)

| Variable | Default | Description |
|---|---|---|
| `MIN_AMOUNT_TEST` | `100` (₹1) | Minimum test payment |
| `MAX_AMOUNT_TEST` | `50000000` (₹5 lakh) | Maximum test payment |
| `MIN_AMOUNT_REAL` | `100` (₹1) | Minimum live payment |
| `MAX_AMOUNT_REAL` | `10000000` (₹1 lakh) | Maximum live payment |

### Session Settings

| Variable | Default | Description |
|---|---|---|
| `SESSION_TIMEOUT_MINUTES` | `2` | QR validity — Razorpay minimum is 2 minutes |
| `TELEGRAM_WEBHOOK_URL` | _(blank)_ | `https://yourdomain.com/api/telegram/webhook` — blank = long polling |

### Advanced

| Variable | Description |
|---|---|
| `MERCHANT_UPI_ID` | Your UPI VPA — generates plain `upi://` QR instead of Razorpay API. ⚠️ User can edit amount. |
| `WELCOME_MESSAGE` | Fully replaces /start message. Placeholder: `{name}` |

---

## Step 1 — Create Telegram Bot

1. Open Telegram → search **@BotFather** → tap **Start**

2. Send `/newbot`

3. BotFather asks:
   - **Name**: Any display name, e.g. `My Payment Bot`
   - **Username**: Must end in `bot`, e.g. `mypayment_bot`

4. BotFather replies with your token:
   ```
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```

5. Paste it into `TELEGRAM_BOT_TOKEN` in `.env`

> **Tip:** Use `/setdescription` and `/setuserpic` in BotFather to add a profile picture and description.

---

## Step 2 — Razorpay API Keys

### 2a. Test Keys (for `/test` command — no real money)

1. Sign in at [dashboard.razorpay.com](https://dashboard.razorpay.com)
2. Toggle to **Test Mode** (top-left switch)
3. Go to **Settings → API Keys → Generate Test Key**
4. Copy both Key ID and Key Secret — Secret is shown only once
5. Paste into `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 2b. Live Keys (for `/real` command — real money)

> Skip if you only want to test. `/real` is disabled when live keys are not set.

1. Complete Razorpay **KYC** (business verification) — required for live mode
2. Toggle to **Live Mode**
3. **Settings → API Keys → Generate Live Key**
4. Paste into `.env`:
   ```
   RAZORPAY_LIVE_KEY_ID=rzp_live_xxxxxxxxxxxxxxxxxxxx
   RAZORPAY_LIVE_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

---

## Step 3 — Razorpay Webhook

Webhooks give **instant** payment detection. Without them, the bot polls every 1.5 seconds (still works, just slightly slower).

> **Skip for local dev** — webhooks require a public HTTPS URL. Polling works fine locally.

### 3a. Generate a Webhook Secret

```bash
# Linux / Mac
openssl rand -hex 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output → paste into `RAZORPAY_WEBHOOK_SECRET` in `.env`

### 3b. Add Webhook in Razorpay Dashboard

1. **Settings → Webhooks → + Add New Webhook**

2. Fill in:

   | Field | Value |
   |---|---|
   | **Webhook URL** | `https://yourdomain.com/api/razorpay/webhook` |
   | **Secret** | The secret you generated above |

3. Enable these **Active Events**:
   - ✅ `qr_code.credited` — UPI payment on QR (primary)
   - ✅ `payment.captured` — any captured payment (backup for live mode)
   - ✅ `payment_link.paid` — web payment link paid (test Pay on Web)

4. Click **Save**

5. Click **Send Test Webhook** — your server should return `200 OK`

> **For live mode:** Switch to Live Mode in dashboard and repeat these steps with the same webhook URL and secret.

### 3c. Verify Webhook is Working

**Settings → Webhooks → [your webhook] → Logs tab** — each delivery shows status code, response, and retry history.

---

## Step 4 — Run Locally

### Install dependencies

```bash
pnpm install
```

### Development (auto-rebuild on changes)

```bash
pnpm --filter @workspace/api-server run dev
```

### Production build

```bash
pnpm --filter @workspace/api-server run build
node ./artifacts/api-server/dist/index.mjs
```

### Local mode (no public URL)

Leave `TELEGRAM_WEBHOOK_URL` blank in `.env` — the bot automatically uses **long-polling mode** (connects to Telegram directly, no incoming webhook needed). Works perfectly for local development.

---

## Step 5 — Test the Bot

### Test mode (no real money)

1. Open your bot in Telegram → send `/test`
2. Send an amount: `100` (₹1) or `500` (₹5)
3. A QR code appears — to simulate payment without a real UPI app:
   - Tap **💻 Pay on Web** button
   - Use UPI ID: `success@razorpay`
   - Or use test card: `4111 1111 1111 1111` / any future expiry / any CVV
4. Bot confirms payment within 1–2 seconds

### Live mode (real money)

1. Make sure live keys are set in `.env`
2. Send `/real`
3. Send an amount (e.g. `1` for ₹1)
4. Scan the QR with any UPI app (GPay, PhonePe, Paytm, BHIM, iMobile, etc.)
5. Pay → bot confirms via webhook instantly

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message — brand name, commands, test tip |
| `/test` | Start a sandbox payment (no real money) |
| `/real` | Start a live UPI payment (real money) |
| `/status` | Check if a payment session is currently active |
| `/cancel` | Cancel a pending amount prompt |
| `/help` | Step-by-step guide, UPI test IDs, how QR works |
| `/about` | About this bot — tech stack, open-source info |

> Commands auto-register in Telegram's "/" menu on bot startup — no manual BotFather setup needed.

---

## Common Use Cases

### Sell a digital product (course, ebook, software)

```env
BRAND_NAME=Ravi Courses
PRODUCT_NAME=Python Course - Lifetime Access
BOT_DESCRIPTION=Learn Python from scratch — lifetime access
PAYMENT_SUCCESS_MESSAGE=🎉 Course access granted!\n\nLink: https://course.com/start\nPayment ID: {payment_id}
DISABLE_TEST_MODE=true
ADMIN_CHAT_ID=123456789
```

User sends `/real` → enters ₹499 → scans QR → pays → course link delivered instantly.

---

### Collect donations (any amount)

```env
BRAND_NAME=Save The Forests NGO
PRODUCT_NAME=Donation
BOT_DESCRIPTION=Every rupee helps us plant trees across India
PAYMENT_SUCCESS_MESSAGE=❤️ Thank you for donating {amount}! Tax receipt: support@ngo.org
SUPPORT_CONTACT=@NGOSupport
```

---

### Sell a service (WhatsApp order follow-up)

```env
BRAND_NAME=Ravi's Designs
PRODUCT_NAME=Logo Design - 48hr delivery
PAYMENT_SUCCESS_MESSAGE=✅ Order received! Payment ID: {payment_id}\n\nWhatsApp us your requirements: https://wa.me/919999999999
ADMIN_CHAT_ID=123456789
```

User sends `/real` → enters ₹1999 → scans QR → pays → WhatsApp link sent. Admin gets notified instantly.

---

### Multi-tier pricing (variable amounts)

```env
PRODUCT_NAME=Consultation Call
MIN_AMOUNT_REAL=50000
MAX_AMOUNT_REAL=500000
PAYMENT_SUCCESS_MESSAGE=📅 Booked! Share your availability at: booking@yoursite.com\nPayment ID: {payment_id}
```

User picks their own amount within the range.

---

### Real-only mode (no test in production)

```env
DISABLE_TEST_MODE=true
```

Hides `/test` completely — buyers only see `/real`.

---

## How It Works

### Payment Flow

```
User sends /real (or /test)
         │
         └─► Bot asks "How much ₹?"
                   User sends amount
         │
         ▼
Validate amount against LIMITS
         │
         ├─► If MERCHANT_UPI_ID is set:
         │       Generate plain upi:// QR (opens UPI app directly)
         │
         └─► Default (Razorpay QR):
                 Call Razorpay API → create single-use fixed-amount QR
                 Download image → crop to QR matrix using sharp
                 Test mode: also create Razorpay payment link (Pay on Web)
         │
         ▼
Send QR photo + countdown timer + inline buttons
         │
         ├─► User scans → UPI app → amount pre-filled → Pay
         └─► User taps Pay on Web → browser checkout (test only)
         │
         ▼
Payment Detection (whichever fires first):
  ┌─────────────────────────────────────────────┐
  │ Layer 1 — Webhook (instant)                 │
  │   Razorpay → POST /api/razorpay/webhook     │
  │   Events: qr_code.credited                  │
  │           payment.captured                  │
  │           payment_link.paid                 │
  │   HMAC verified → session found → onPayment │
  ├─────────────────────────────────────────────┤
  │ Layer 2 — Polling fallback (every 1.5s)     │
  │   rzp.qrCode.fetchAllPayments(qrId)         │
  │   Items found → onPayment()                 │
  └─────────────────────────────────────────────┘
         │
         ▼
handlePaymentReceived():
  → Send confirmation to buyer
  → Send PAYMENT_SUCCESS_MESSAGE (product delivery)
  → Notify ADMIN_CHAT_ID (if set)
  → Delete QR, close session
```

### Session Lifecycle

```
/real or /test sent
    │
    └─► "How much ₹?" ─► user sends amount ─► QR created
                                                        │
                              ┌─────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   ACTIVE SESSION    │
                   │  countdown running  │
                   │  polling every 1.5s │
                   └──────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Payment          Timeout          Cancel
        confirmed          (2min)          button
              │               │               │
              └───────────────┴───────────────┘
                              │
                    Session deleted, QR removed
```

### Webhook Events Handled

| Event | When it fires | Used for |
|---|---|---|
| `qr_code.credited` | UPI payment on QR | Primary QR detection |
| `payment.captured` | Any payment captured | Backup, live mode (has `qr_code_id`) |
| `payment_link.paid` | Web payment link paid | Pay on Web (test mode) |

All webhook requests verified with HMAC-SHA256 (`crypto.timingSafeEqual`). Invalid signatures → `400 Bad Request`.

---

## Project Structure

```
/
├── .env.example                  ← Template — copy to .env and fill in values
├── .gitignore                    ← .env excluded from Git
├── Dockerfile                    ← Docker build for production
├── README.md                     ← This file
├── package.json                  ← Root workspace (pnpm)
├── pnpm-workspace.yaml           ← Monorepo config
├── tsconfig.base.json            ← Shared TypeScript config
│
├── artifacts/api-server/         ← THE BOT — main source
│   ├── build.mjs                 ← esbuild bundler config (TS → single dist/index.mjs)
│   ├── package.json              ← Bot dependencies
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              ← Entry: starts HTTP server + bot
│       ├── app.ts                ← Express app: routes, CORS, logging middleware
│       ├── config.ts             ← All env vars + AI guide + use-case docs
│       ├── bot.ts                ← Core logic: commands, QR, detection, sessions
│       │                            handlePaymentReceived() ← EXTEND HERE
│       ├── bot-sessions.ts       ← Session state Map + webhook bridge
│       ├── lib/
│       │   └── logger.ts         ← Pino structured logger
│       └── routes/
│           ├── health.ts         ← GET /api/healthz
│           ├── index.ts          ← Route registration
│           └── razorpay-webhook.ts ← POST /api/razorpay/webhook + HMAC verify
│
└── lib/
    ├── api-zod/                  ← Shared Zod schemas (used by health check)
    └── db/                       ← Shared DB utilities (optional — not used by bot by default)
```

---

## Deploy to Production

### Option A — Railway (recommended)

1. Fork this repo on GitHub
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your fork
4. **Variables** tab → add all `.env` values
5. Set `TELEGRAM_WEBHOOK_URL=https://your-app.up.railway.app/api/telegram/webhook`
6. Add Razorpay webhook: `https://your-app.up.railway.app/api/razorpay/webhook`
7. Railway auto-deploys on every push to `main`

### Option B — Render (free tier)

1. Fork this repo
2. [render.com](https://render.com) → **New → Web Service → Connect GitHub**
3. Settings:
   - **Build Command**: `npm install -g pnpm && pnpm install && pnpm --filter @workspace/api-server run build`
   - **Start Command**: `node ./artifacts/api-server/dist/index.mjs`
4. Add env variables in **Environment** tab
5. Set `TELEGRAM_WEBHOOK_URL=https://your-app.onrender.com/api/telegram/webhook`

### Option C — VPS / Ubuntu

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

# Clone and configure
git clone https://github.com/vishwajeetcoderr-dev/tg-upi-live.git
cd tg-upi-live
cp .env.example .env
nano .env   # fill in all values

# Install, build, run
pnpm install
pnpm --filter @workspace/api-server run build

# Run with PM2 (survives SSH logout + auto-restart on reboot)
npm install -g pm2
pm2 start "node ./artifacts/api-server/dist/index.mjs" --name rzp-bot
pm2 save
pm2 startup   # follow the printed command
pm2 logs rzp-bot   # view live logs
```

**HTTPS with Nginx + Certbot:**

```nginx
server {
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo ln -s /etc/nginx/sites-available/rzp-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

### Option D — Docker

```bash
# Build
docker build -t rzp-upi-bot .

# Run
docker run -d --name rzp-upi-bot --env-file .env -p 8080:8080 rzp-upi-bot
```

With Docker Compose (`docker-compose.yml`):

```yaml
version: "3.9"
services:
  bot:
    build: .
    env_file: .env
    ports:
      - "8080:8080"
    restart: unless-stopped
```

```bash
docker-compose up -d
docker-compose logs -f
```

### Option E — Replit (one-click, zero setup)

1. Click **[Run on Replit](https://replit.com/new/github/vishwajeetcoderr-dev/tg-upi-live)**
2. Click the **Padlock (Secrets)** icon in the left sidebar
3. Add each key from `.env.example` — `REPLIT_DEV_DOMAIN` is set automatically, so `TELEGRAM_WEBHOOK_URL` is not needed
4. Click **Run** — bot starts automatically

---

## Extend with Custom Logic

### Add code after payment

Open `src/bot.ts` → find `handlePaymentReceived()`:

```typescript
async function handlePaymentReceived(
  session: Session,
  paymentId: string,
  amountPaise: number
): Promise<void> {
  await cleanupSession(session, false);  // cleanup timers
  await deleteQR(session, "paid");       // remove QR from chat

  // ── ADD YOUR LOGIC HERE ────────────────────────────────────────────────

  // Save to database:
  await db.insert(payments).values({
    chatId: session.chatId,
    paymentId,
    amountPaise,
    createdAt: new Date(),
  });

  // Generate and send a license key:
  const key = await generateLicenseKey(paymentId);
  await bot.api.sendMessage(session.chatId, `🔑 Your key: ${key}`);

  // Notify admin on a different chat:
  await bot.api.sendMessage(ADMIN_CHAT_ID, `💰 ₹${amountPaise/100} received — ${paymentId}`);

  // Call your own API:
  await fetch("https://yourapi.com/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: session.chatId, paymentId, amountPaise }),
  });

  // Grant membership / subscription:
  await grantAccess(session.chatId, getExpiryDate(amountPaise));

  // ──────────────────────────────────────────────────────────────────────

  await bot.api.sendMessage(session.chatId, "✅ Thank you!", { parse_mode: "HTML" });
}
```

### Available session data

```typescript
session.chatId        // Telegram chat ID of the buyer
session.amountPaise   // Amount paid in paise (÷ 100 = ₹)
session.mode          // "test" or "real"
session.linkId        // Razorpay QR code ID
paymentId             // Razorpay payment ID (pay_XxYy1234)
```

### Add a new command

```typescript
// In bot.ts, after the existing commands:
bot.command("invoice", async (ctx) => {
  // your handler
});
```

### Change the QR message format

Find `buildCaption()` in `bot.ts` — edit the template string to change the QR image caption.

---

## Troubleshooting

### Bot doesn't respond

- Check `TELEGRAM_BOT_TOKEN` is correct
- If webhook mode: verify `TELEGRAM_WEBHOOK_URL` is publicly reachable
- Check webhook status: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Try long-polling: leave `TELEGRAM_WEBHOOK_URL` blank, restart

### QR creation fails: `close_by should be at least 2 minutes`

- Razorpay requires QR expiry ≥ 2 minutes — the bot adds 30s buffer
- If persists, your server clock is behind: `date` to check, then `sudo ntpdate -u pool.ntp.org`

### Payment link fails: `expire_by must be at least 15 minutes`

- Bot sets 20 minutes to account for clock skew
- If still failing: sync your server clock

### Webhook not receiving events

- Server must be public HTTPS — localhost won't work
- Check **Razorpay Dashboard → Settings → Webhooks → [your webhook] → Logs**
- Verify all 3 events are enabled: `qr_code.credited`, `payment.captured`, `payment_link.paid`
- Check `RAZORPAY_WEBHOOK_SECRET` exactly matches dashboard (no spaces/quotes)
- Test: **Send Test Webhook** in dashboard — should return `200 OK`

### Webhook returns 400 Invalid signature

- Secret mismatch between `.env` and Razorpay dashboard
- Regenerate: `openssl rand -hex 32` → update both `.env` and dashboard → restart

### Payment detected only after "Check Now"

- Webhook not configured — polling fallback detected it
- Set up webhook (Step 3) for instant detection

### `/real` shows "Live keys not configured"

- Add `RAZORPAY_LIVE_KEY_ID` and `RAZORPAY_LIVE_KEY_SECRET` to `.env`
- Must use `rzp_live_` keys (not `rzp_test_`)
- Restart server

### `TELEGRAM_BOT_TOKEN not set` in logs

- Missing or wrong token — check `.env`
- No extra spaces or quotes around the value

---

## Open Source on GitHub

### Step 1 — Create GitHub Repo

1. [github.com](https://github.com) → **+ → New repository**
2. Name: `tg-upi-live`
3. Set **Public**
4. Do NOT check "Initialize with README"
5. **Create repository**

### Step 2 — Push Code

```bash
git init
git add .
git commit -m "Initial release: Razorpay UPI Telegram bot"
git branch -M main
git remote add origin https://github.com/vishwajeetcoderr-dev/tg-upi-live.git
git push -u origin main
```

### Step 3 — Verify .env is NOT in Git

After pushing, open your GitHub repo and confirm **no `.env` file** exists (only `.env.example`). If `.env` was accidentally pushed:

```bash
git rm --cached .env
git commit -m "Remove .env from tracking"
git push
```

### Step 4 — Add GitHub Topics

On your repo → click gear next to **About** → add topics:
`telegram-bot` `razorpay` `upi` `payment` `nodejs` `typescript` `grammy` `india` `fintech`

### Step 5 — Add License File

The project uses **MIT License**. To add the `LICENSE` file on GitHub:
- Repo → **Add file → Create new file** → name it `LICENSE`
- Click **Choose a license template → MIT** → fill your name → submit

---

## Security Notes

- `.env` is in `.gitignore` — never commit it to Git
- All Razorpay webhooks are verified with `crypto.timingSafeEqual` (HMAC-SHA256)
- In **development** (`NODE_ENV=development`): unsigned webhooks are processed with a warning (Razorpay dashboard may not have secret configured yet)
- In **production** (`NODE_ENV=production`): unsigned webhooks are rejected with `400` — always set `RAZORPAY_WEBHOOK_SECRET`
- Each session creates a **single-use** QR — cannot be reused or replayed after payment
- Set `RAZORPAY_WEBHOOK_SECRET` before deploying to production
- Admin notifications (`ADMIN_CHAT_ID`) are sent separately from buyer messages — even if buyer is the admin, no duplicate messages

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Language | TypeScript |
| Bot framework | [grammY](https://grammy.dev) |
| HTTP server | Express 5 |
| Payment gateway | [Razorpay SDK](https://razorpay.com/docs/api/) |
| QR cropping | [sharp](https://sharp.pixelplumbing.com) |
| QR generation | [qrcode](https://www.npmjs.com/package/qrcode) |
| Logging | [pino](https://getpino.io) |
| Build | [esbuild](https://esbuild.github.io) |
| Package manager | pnpm (monorepo) |

---

*Built with ❤️ for Indian sellers collecting UPI payments via Telegram.*
