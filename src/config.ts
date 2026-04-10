// =============================================================================
// ██████╗  ██████╗ ████████╗    ███████╗███████╗████████╗██╗   ██╗██████╗
// ██╔══██╗██╔═══██╗╚══██╔══╝    ██╔════╝██╔════╝╚══██╔══╝██║   ██║██╔══██╗
// ██████╔╝██║   ██║   ██║       ███████╗█████╗     ██║   ██║   ██║██████╔╝
// ██╔══██╗██║   ██║   ██║       ╚════██║██╔══╝     ██║   ██║   ██║██╔═══╝
// ██████╔╝╚██████╔╝   ██║       ███████║███████╗   ██║   ╚██████╔╝██║
// ╚═════╝  ╚═════╝    ╚═╝       ╚══════╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝
//
// AI INTEGRATION GUIDE — READ THIS FILE FIRST
// =============================================================================
//
// This file is the single source of truth for ALL customizable settings.
// An AI reading this codebase should start here, then open bot.ts.
//
// ── WHAT THIS BOT DOES ────────────────────────────────────────────────────
//
//  A Telegram bot that collects UPI payments via Razorpay QR codes.
//  Users send /real (or /test for sandbox), optionally enter an amount,
//  receive a QR code with the amount pre-filled, scan it in any UPI app,
//  and the bot confirms payment instantly via webhook or 1.5s polling.
//
// ── COMPLETE PAYMENT FLOW ─────────────────────────────────────────────────
//
//  1. User sends /real → bot replies "How much ₹?"
//  2. User sends amount (e.g. "500") → bot validates against LIMITS
//  3. Bot calls Razorpay API → creates single-use fixed-amount QR code
//  4. Bot sends QR image + countdown + buttons (Check Now, Cancel)
//     Test mode also has a "Pay on Web" URL button (Razorpay hosted checkout)
//  5. User scans QR → UPI app opens → amount auto-filled → user taps Pay
//  6. Razorpay fires webhook → bot receives at POST /api/razorpay/webhook → instant
//     OR: polling every 1.5s → rzp.qrCode.fetchAllPayments()
//  7. handlePaymentReceived() fires → sends confirmation + PAYMENT_SUCCESS_MESSAGE
//     + optionally notifies ADMIN_CHAT_ID
//  8. Session ends, QR image is deleted from chat
//
// ── FILE MAP (read in this order) ─────────────────────────────────────────
//
//  config.ts              ← YOU ARE HERE — all customizable settings
//  bot.ts                 ← Core logic: commands, QR, sessions, detection
//    handlePaymentReceived()  ← EXTENSION POINT: add your logic after payment
//    handleTimeout()          ← Fires when QR expires
//    buildCaption()           ← Customize QR message format
//    startPaymentSession()    ← QR creation + polling start
//    /start, /help, /about    ← User-facing commands
//    /real, /test             ← Payment triggers
//  bot-sessions.ts        ← Session state (Map), types, webhook notifier
//  routes/razorpay-webhook.ts ← Webhook endpoint + HMAC verification
//  app.ts                 ← Express server, route registration
//  index.ts               ← Entry: starts server + bot
//
// ── HOW TO WIRE UP (5 steps) ──────────────────────────────────────────────
//
//  STEP 1 — Required env vars (.env):
//    TELEGRAM_BOT_TOKEN=         (from @BotFather)
//    RAZORPAY_KEY_ID=            (rzp_test_... from Razorpay Dashboard)
//    RAZORPAY_KEY_SECRET=
//    PORT=8080
//
//  STEP 2 — Seller/brand config:
//    BRAND_NAME=                 your business name
//    PRODUCT_NAME=               what you're selling
//    PAYMENT_SUCCESS_MESSAGE=    message after payment (deliver product here)
//    SUPPORT_CONTACT=            @YourUsername or https://wa.me/91XXXXXXXXXX
//
//  STEP 3 — Build and run:
//    pnpm install
//    pnpm --filter @workspace/api-server run build
//    node ./artifacts/api-server/dist/index.mjs
//
//  STEP 4 — Razorpay webhook (Dashboard → Settings → Webhooks):
//    URL:    https://yourdomain.com/api/razorpay/webhook
//    Secret: set RAZORPAY_WEBHOOK_SECRET in .env
//    Events: ✅ qr_code.credited  ✅ payment.captured  ✅ payment_link.paid
//
//  STEP 5 — Optional: Telegram webhook for instant message delivery:
//    TELEGRAM_WEBHOOK_URL=https://yourdomain.com/api/telegram/webhook
//    (if blank → long-polling, works fine locally)
//
// ── PRIMARY EXTENSION POINT ───────────────────────────────────────────────
//
//  After a payment is confirmed, add your logic in bot.ts → handlePaymentReceived():
//
//    // paste AFTER cleanupSession() line:
//    await db.insert(payments).values({ chatId: session.chatId, paymentId, amountPaise });
//    const key = await generateLicenseKey(paymentId);
//    await bot.api.sendMessage(session.chatId, `🔑 Your key: ${key}`);
//
//  session.chatId     — Telegram chat ID (who paid)
//  session.amountPaise — Amount in paise (÷100 = ₹)
//  session.mode       — "test" or "real"
//  paymentId          — Razorpay payment ID (e.g. pay_XxYy1234)
//
// ── COMMON USE CASES ──────────────────────────────────────────────────────
//
//  Donations (any amount):
//    PRODUCT_NAME=Donation
//    PAYMENT_SUCCESS_MESSAGE="❤️ Thank you! Your support means the world."
//
//  Real-only mode (no test mode):
//    DISABLE_TEST_MODE=true
//
//  Admin notification on every payment:
//    ADMIN_CHAT_ID=123456789    → get your ID from @userinfobot
//
// ── SECURITY CHECKLIST ────────────────────────────────────────────────────
//
//  ✅ .env is in .gitignore — secrets never committed
//  ✅ Webhooks verified with HMAC-SHA256 (timingSafeEqual)
//  ✅ Each QR is single-use — cannot be replayed
//  ✅ RAZORPAY_WEBHOOK_SECRET required in production
//
// =============================================================================

import type { PaymentMode } from "./bot-sessions.js";

// ── Branding ──────────────────────────────────────────────────────────────────

/** Your business or brand name.
 *  Used in: QR code name, UPI pn= field, /start message, payment descriptions. */
export const BRAND_NAME = process.env.BRAND_NAME ?? "My Store";

/** What you are selling — product or service name.
 *  Used in: QR description, payment link, confirmation message. */
export const PRODUCT_NAME = process.env.PRODUCT_NAME ?? "Payment";

/** Short tagline or description shown in /start below BRAND_NAME.
 *  Leave blank for default. E.g. "Premium digital products delivered instantly" */
export const BOT_DESCRIPTION = process.env.BOT_DESCRIPTION ?? "";

// ── Post-payment delivery ─────────────────────────────────────────────────────

/**
 * Message sent to the buyer immediately after payment is confirmed.
 * Deliver your product here — key, link, instructions.
 *
 * Placeholders: {amount}  {payment_id}  {mode}
 * HTML supported: <b>bold</b>  <i>italic</i>  <code>mono</code>  \n for newlines
 *
 * Examples:
 *   "🔑 License key: XYZ-1234-ABCD"
 *   "📦 Download: https://yoursite.com/dl?id={payment_id}"
 *   "✅ Order received! WhatsApp +91-9999999999 with ID: {payment_id}"
 */
export const PAYMENT_SUCCESS_MESSAGE = process.env.PAYMENT_SUCCESS_MESSAGE ?? "";

// ── Admin notifications ───────────────────────────────────────────────────────

/**
 * Telegram chat ID of the admin/seller.
 * If set, the bot sends a notification to this chat on every confirmed payment.
 * Get your chat ID: message @userinfobot on Telegram.
 * E.g. ADMIN_CHAT_ID=123456789
 */
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID
  ? parseInt(process.env.ADMIN_CHAT_ID, 10)
  : null;

// ── Support contact ───────────────────────────────────────────────────────────

/**
 * Shown in /help as the support contact.
 * Use a Telegram username: @YourSupport
 * Or a WhatsApp link: https://wa.me/91XXXXXXXXXX
 * Leave blank to hide the support line.
 */
export const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT ?? "";

// ── Open-source link ─────────────────────────────────────────────────────────

/**
 * Link to the GitHub repo — shown in /about.
 * Leave blank to hide the open-source section.
 * E.g. https://github.com/vishwajeetcoderr-dev/tg-upi-live
 */
export const GITHUB_URL = process.env.GITHUB_URL ?? "";

// ── Welcome / start message ───────────────────────────────────────────────────

/**
 * Fully replaces the /start command message if set.
 * Placeholder: {name} → user's Telegram first name.
 * HTML supported.
 * Leave blank for the auto-generated message.
 */
export const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE ?? "";

// ── Session settings ──────────────────────────────────────────────────────────

/** QR code validity (minutes, default: 2).
 *  Both bot session AND Razorpay QR expire at the same time.
 *  Razorpay minimum: 2 minutes. Do not set below 2. */
export const TIMEOUT_MS =
  Math.max(2, parseInt(process.env.SESSION_TIMEOUT_MINUTES ?? "2", 10)) * 60 * 1000;

/** How often to poll Razorpay for payment (milliseconds). */
export const POLL_INTERVAL_MS = 1_500;

/** How often the countdown timer refreshes in the QR message (milliseconds). */
export const COUNTDOWN_INTERVAL_MS = 3_000;

// ── Amount limits ─────────────────────────────────────────────────────────────
//
//  All values are in PAISE — multiply rupee amount × 100
//  ₹1=100  ₹10=1000  ₹100=10000  ₹500=50000  ₹1000=100000
//
//  TIP: Set MIN = MAX to force a single fixed amount for all payments.

export const LIMITS: Record<PaymentMode, { min: number; max: number }> = {
  test: {
    min: Math.max(1, parseInt(process.env.MIN_AMOUNT_TEST ?? "100", 10)),
    max: Math.max(1, parseInt(process.env.MAX_AMOUNT_TEST ?? "50000000", 10)),
  },
  real: {
    min: Math.max(1, parseInt(process.env.MIN_AMOUNT_REAL ?? "100", 10)),
    max: Math.max(1, parseInt(process.env.MAX_AMOUNT_REAL ?? "10000000", 10)),
  },
};

// ── Feature flags ─────────────────────────────────────────────────────────────

/** Set DISABLE_TEST_MODE=true to hide /test command in production. */
export const DISABLE_TEST_MODE = process.env.DISABLE_TEST_MODE === "true";
