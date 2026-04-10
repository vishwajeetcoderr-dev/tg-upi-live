// =============================================================================
// bot.ts — CORE BOT LOGIC
// =============================================================================
//
// AI QUICK REFERENCE:
//   • To customize settings/text  → edit config.ts (or set env vars in .env)
//   • To run code after payment   → find handlePaymentReceived() ~line 180
//   • To change QR message format → find buildCaption() ~line 90
//   • To change timeout behavior  → find handleTimeout() ~line 220
//   • To add a new /command       → add bot.command("name", handler) near bottom
//   • To change amount prompt     → find handleModeCommand() ~line 510
//
// SESSION LIFECYCLE:
//   IDLE → [/real or /test] → PENDING_AMOUNT → [user sends amount] →
//   ACTIVE (QR shown, countdown running) →
//     Paid:      handlePaymentReceived() → session deleted
//     Timeout:   handleTimeout()         → session deleted
//     Cancelled: cancel button           → session deleted
//
// PAYMENT DETECTION (two layers, whichever fires first):
//   Layer 1 — Webhook (instant):  POST /api/razorpay/webhook → notifyPaymentLinkPaid()
//   Layer 2 — Polling (1.5s):     setInterval → findMatchingPayment() → rzp.qrCode.fetchAllPayments()
//
// =============================================================================

import { randomUUID } from "crypto";
import { Bot, InputFile, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import Razorpay from "razorpay";
import sharp from "sharp";

import QRCode from "qrcode";
import {
  sessions,
  pendingInputs,
  type Session,
  type PaymentMode,
  getActiveSessionByChatId,
  clearPendingInput,
  notifyPaymentLinkPaid,
} from "./bot-sessions.js";
import { logger } from "./lib/logger.js";
import {
  BRAND_NAME,
  PRODUCT_NAME,
  BOT_DESCRIPTION,
  PAYMENT_SUCCESS_MESSAGE,
  ADMIN_CHAT_ID,
  SUPPORT_CONTACT,
  GITHUB_URL,
  WELCOME_MESSAGE,
  TIMEOUT_MS,
  POLL_INTERVAL_MS,
  COUNTDOWN_INTERVAL_MS,
  LIMITS,
  DISABLE_TEST_MODE,
} from "./config.js";

export { notifyPaymentLinkPaid };

/** Crop Razorpay's full QR image to just the plain QR matrix with white padding */
async function cropQrImage(inputBuffer: Buffer): Promise<Buffer> {
  const img = sharp(inputBuffer);
  const { width = 674, height = 1644 } = await img.metadata();
  // Measured on 674×1644 template: white card x=106–567, QR matrix y≈652–1027
  return img.extract({
    top:    Math.round(height * 0.397),  // below BHIM/UPI logos
    left:   Math.round(width  * 0.157),  // white card left edge
    width:  Math.round(width  * 0.684),  // white card width
    height: Math.round(height * 0.228),  // QR matrix height
  })
  .extend({ top: 20, bottom: 20, left: 20, right: 20,
            background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .png().toBuffer();
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format paise as Indian rupee string — e.g. ₹1,00,000.00 */
function formatINR(paise: number): string {
  const rupees = paise / 100;
  return "₹" + new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/** Parse user text input to paise. Returns null on invalid/non-numeric input.
 *  Accepts: integers (50, 1000) and up to 2 decimal places (50.5, 50.50, 1500.99)
 *  Rejects: trailing chars (50abc), multiple dots (1.2.3), 3+ decimals (50.123),
 *           scientific notation (1e5), negative, zero, empty, non-numeric.
 */
function parseAmountPaise(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, "").replace(/^₹\s*/, "");
  // Strict regex: digits only, optional single dot with 1-2 decimal digits
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (!isFinite(n) || isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function makeKeyboard(linkId: string, webPayUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (webPayUrl) kb.url("💻 Pay on Web", webPayUrl).row();
  kb.text("🔍 Check Now", `check:${linkId}`).text("❌ Cancel", `cancel:${linkId}`);
  return kb;
}

function buildCaption(
  mode: PaymentMode,
  amountPaise: number,
  timeRemaining: string,
  note?: string
): string {
  const badge = mode === "test" ? "🧪 TEST" : "🔴 LIVE";
  const amount = esc(formatINR(amountPaise));
  let txt =
    `<b>${badge}  ·  ${amount}</b>\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `💰 Pay exactly: <b>${amount}</b>\n` +
    `⏳ Expires in: <b>${esc(timeRemaining)}</b>\n\n` +
    `📱 Scan → UPI app opens → <b>₹${esc(formatINR(amountPaise).replace("₹", "").trim())} auto-filled</b> → just tap Pay`;
  if (note) txt += `\n\n${note}`;
  return txt;
}

/** Safely extract payment_id — handles both `payment_id` and `id` field names */
function extractPaymentId(pmt: Record<string, unknown>): string {
  const val = pmt["payment_id"] ?? pmt["id"];
  return val != null ? String(val) : "unknown";
}

/** Safely extract amount in paise — handles string/number */
function extractAmountPaise(pmt: Record<string, unknown>, fallback: number): number {
  const raw = pmt["amount"];
  if (raw == null) return fallback;
  const n = Number(raw);
  return isNaN(n) ? fallback : n;
}

export function startBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    logger.error("RAZORPAY test credentials not set — bot will not start");
    return;
  }

  const bot = new Bot(token);

  const rzpTest = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  const rzpLive =
    process.env.RAZORPAY_LIVE_KEY_ID && process.env.RAZORPAY_LIVE_KEY_SECRET
      ? new Razorpay({
          key_id: process.env.RAZORPAY_LIVE_KEY_ID,
          key_secret: process.env.RAZORPAY_LIVE_KEY_SECRET,
        })
      : null;

  logger.info(
    { liveKeysLoaded: rzpLive !== null },
    rzpLive ? "✅ Live Razorpay keys loaded — /real command enabled" : "⚠️  Live keys not found — /real will show config error"
  );

  function getRzp(mode: PaymentMode): Razorpay {
    if (mode === "real") {
      if (!rzpLive) throw new Error("Live Razorpay keys not configured");
      return rzpLive;
    }
    return rzpTest;
  }

  async function cleanupSession(session: Session, cancelLink: boolean): Promise<void> {
    if (session.pollIntervalId !== null) clearInterval(session.pollIntervalId);
    if (session.countdownIntervalId !== null) clearInterval(session.countdownIntervalId);
    sessions.delete(session.linkId);
    clearPendingInput(session.chatId);
    // Close the single-use QR so it can't be paid after cancellation/timeout
    if (cancelLink && !session.directUpi) {
      getRzp(session.mode).qrCode.close(session.linkId).catch(() => {});
    }
  }

  async function deleteQR(session: Session, reason: string): Promise<void> {
    try {
      await bot.api.deleteMessage(session.chatId, session.messageId);
    } catch (err) {
      logger.debug({ err }, `deleteMessage (QR) skipped — ${reason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ██████╗  EXTENSION POINT — ADD YOUR CUSTOM LOGIC HERE
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // handlePaymentReceived() is called the moment a payment is confirmed.
  // This is where you deliver the product, save to DB, or call your API.
  //
  // Available data:
  //   session.chatId       — Telegram chat ID of the buyer (send messages here)
  //   session.amountPaise  — Amount paid in paise (÷100 = rupees)
  //   session.mode         — "test" or "real"
  //   session.linkId       — Razorpay QR code ID
  //   paymentId            — Razorpay payment ID (e.g. pay_XxYyZz123)
  //   amountPaise          — Amount in paise (same as session.amountPaise for QR)
  //
  // Common additions (paste after cleanupSession line):
  //
  //   // Save payment record to database:
  //   await db.insert(payments).values({ chatId: session.chatId, paymentId, amountPaise });
  //
  //   // Send a product key or download link:
  //   const key = await generateLicenseKey(paymentId);
  //   await bot.api.sendMessage(session.chatId, `🔑 Your key: ${key}`);
  //
  //   // Notify admin on another Telegram chat:
  //   await bot.api.sendMessage(ADMIN_CHAT_ID, `💰 Payment: ${paymentId} — ₹${amountPaise/100}`);
  //
  //   // Call your own backend API:
  //   await fetch("https://yourapi.com/webhooks/payment", {
  //     method: "POST",
  //     body: JSON.stringify({ chatId: session.chatId, paymentId, amountPaise }),
  //   });
  //
  //   // Grant access in your system (membership, subscription, etc.):
  //   await grantMembership(session.chatId, getDurationFromAmount(amountPaise));
  //
  // ═══════════════════════════════════════════════════════════════════════════
  async function handlePaymentReceived(
    session: Session,
    paymentId: string,
    amountPaise: number
  ): Promise<void> {
    const amount = formatINR(amountPaise);
    // QR already paid — no need to cancel/close it
    await cleanupSession(session, false);
    await deleteQR(session, "payment confirmed");

    const nextCmd = session.mode === "test" ? "/test" : "/real";
    const nextHint = session.mode === "test" ? "run another test" : "make another payment";
    const modeTag = session.mode === "test" ? "TEST" : "LIVE";

    // Build the custom post-payment message from template (if configured)
    let customMsg = "";
    if (PAYMENT_SUCCESS_MESSAGE.trim()) {
      customMsg =
        "\n\n" +
        PAYMENT_SUCCESS_MESSAGE
          .replace(/\{amount\}/g, amount)
          .replace(/\{payment_id\}/g, paymentId)
          .replace(/\{mode\}/g, modeTag);
    }

    const modeEmoji = session.mode === "test" ? "🧪" : "🔴";
    const modeLabel = session.mode === "test" ? "Test Mode" : "Live Mode";

    await bot.api.sendMessage(
      session.chatId,
      `🎉  <b>PAYMENT SUCCESS!</b>\n\n` +
      `💰  <b>${esc(amount)}</b>\n` +
      `🔖  ${esc(PRODUCT_NAME)}\n` +
      `🆔  <code>${esc(paymentId)}</code>\n` +
      `🔒  Secured by Razorpay\n` +
      `${modeEmoji}  ${modeLabel}` +
      `${customMsg}\n\n` +
      `<i>Send ${nextCmd} to ${nextHint}</i>`,
      { parse_mode: "HTML" }
    );

    // ── Admin notification (optional) ─────────────────────────────────────
    // Notify ADMIN_CHAT_ID when a payment is confirmed. Set via env var.
    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== session.chatId) {
      try {
        await bot.api.sendMessage(
          ADMIN_CHAT_ID,
          `🎉 <b>New Payment!</b>\n\n` +
          `💰 <b>${esc(amount)}</b>\n` +
          `🔖 ${esc(PRODUCT_NAME)}\n` +
          `🆔 <code>${esc(paymentId)}</code>\n` +
          `👤 Chat ID: <code>${session.chatId}</code>\n` +
          `${modeEmoji} ${modeLabel}`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        logger.warn({ err }, "Admin notification failed");
      }
    }
  }

  async function handleTimeout(session: Session): Promise<void> {
    await cleanupSession(session, true);
    await deleteQR(session, "timeout");

    const nextCmd = session.mode === "test" ? "/test" : "/real";
    const retryHint = session.mode === "test" ? "try another test" : "try another payment";
    const timeoutLabel = formatTime(TIMEOUT_MS);
    await bot.api.sendMessage(
      session.chatId,
      `⏰ <b>Session Expired</b>\n\n` +
      `No payment received within ${timeoutLabel}.\n` +
      `<i>Send ${nextCmd} to ${retryHint}</i>`,
      { parse_mode: "HTML" }
    );
  }

  /** Poll Razorpay payments list and find one matching this session's amount */
  async function findMatchingPayment(session: Session): Promise<{ id: string; amount: number } | null> {
    const rzp = getRzp(session.mode);

    if (session.directUpi) {
      // Direct UPI — poll all payments since session start, match by captured + amount
      const result = await rzp.payments.all({ from: session.sessionStartTs, count: 50 });
      const pmts = (result as { items: Array<{ id: string; amount: number; status: string }> }).items ?? [];
      const match = pmts.find(
        (p) => p.status === "captured" && p.amount === session.amountPaise
      );
      return match ? { id: match.id, amount: match.amount } : null;
    }

    // Single-use fixed-amount QR — any payment on this QR is the session payment
    const result = await rzp.qrCode.fetchAllPayments(session.linkId);
    const items = (result as {
      count: number;
      items: Array<{ id?: string; payment_id?: string; amount?: number }>;
    }).items ?? [];

    if (items.length) {
      const p = items[0];
      const pid = p.payment_id ?? p.id ?? "unknown";
      return { id: pid, amount: typeof p.amount === "number" ? p.amount : session.amountPaise };
    }

    // QR came up empty — also check payment link (test mode "Pay on Web")
    if (session.webPayLinkId) {
      try {
        const link = await rzp.paymentLink.fetch(session.webPayLinkId) as {
          status: string;
          amount: number;
        };
        if (link.status === "paid") {
          // Payment link is paid — find the actual payment via payments list
          // (paymentLink.fetch() does not reliably include sub-payment details)
          try {
            const pmtResult = await rzp.payments.all({
              from: session.sessionStartTs,
              count: 20,
            });
            const pmts = (pmtResult as {
              items: Array<{ id: string; amount: number; status: string }>;
            }).items ?? [];
            const match = pmts.find(
              (p) =>
                (p.status === "captured" || p.status === "authorized") &&
                p.amount === session.amountPaise
            );
            const pid = match?.id ?? "unknown";
            return { id: pid, amount: match?.amount ?? session.amountPaise };
          } catch (pmtErr) {
            logger.debug({ pmtErr }, "Payment lookup after link paid failed");
            return { id: "unknown", amount: session.amountPaise };
          }
        }
      } catch (err) {
        logger.debug({ err }, "Payment link status check failed");
      }
    }

    return null;
  }

  async function forceCheckPayment(session: Session): Promise<boolean> {
    if (session.resolved) return true;
    try {
      const match = await findMatchingPayment(session);
      if (session.resolved) return true;
      if (match) {
        session.resolved = true;
        await handlePaymentReceived(session, match.id, match.amount);
        return true;
      }
    } catch (err) {
      logger.warn({ err }, "Force check error");
    }
    return false;
  }

  /**
   * Build a direct UPI QR buffer — encodes upi://pay URI so any UPI app opens inline.
   * MERCHANT_UPI_ID env var is the receiving UPI VPA (e.g. merchant@upi).
   */
  async function buildDirectUpiQr(
    upiId: string,
    amountPaise: number,
    mode: PaymentMode
  ): Promise<Buffer> {
    const rupees = (amountPaise / 100).toFixed(2);
    const label = mode === "test" ? "Test Payment" : "Payment";
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(BRAND_NAME)}&am=${rupees}&cu=INR&tn=${encodeURIComponent(label)}`;
    return QRCode.toBuffer(upiUri, {
      type: "png",
      width: 512,
      margin: 3,
      color: {
        dark: mode === "test" ? "#1a1a2e" : "#7b1e1e",
        light: "#ffffff",
      },
    });
  }

  /** Create UPI QR, send photo, start polling + countdown */
  async function startPaymentSession(
    chatId: number,
    mode: PaymentMode,
    amountPaise: number
  ): Promise<void> {
    const modeLabel = mode === "test" ? "test" : "live";
    const merchantUpiId = process.env.MERCHANT_UPI_ID;
    const sessionStartTs = Math.floor(Date.now() / 1000);

    const creating = await bot.api.sendMessage(
      chatId,
      `⚙️ <i>Generating ${modeLabel} UPI QR for ${esc(formatINR(amountPaise))}...</i>`,
      { parse_mode: "HTML" }
    );

    // ── Strategy: direct upi:// QR (primary) → Razorpay QR API → payment link ──

    let qrBuffer: Buffer;
    let sessionId: string;
    let isDirectUpi = false;
    let webPayUrl: string | undefined;
    let webPayLinkId: string | undefined;

    if (merchantUpiId) {
      // Best path: pure upi:// QR — opens UPI app directly, zero browser
      sessionId = randomUUID();
      isDirectUpi = true;
      try {
        qrBuffer = await buildDirectUpiQr(merchantUpiId, amountPaise, mode);
        logger.info({ sessionId, upiId: merchantUpiId }, "Direct UPI QR generated");
      } catch (err) {
        logger.error({ err }, "Failed to generate UPI QR");
        await bot.api.editMessageText(chatId, creating.message_id,
          `❌ <b>Failed to generate UPI QR.</b> Please try again.`, { parse_mode: "HTML" });
        return;
      }
    } else {
      // Razorpay single-use fixed-amount QR — amount pre-encoded, auto-fills in UPI app
      try {
        const rzp = getRzp(mode);
        const qr = await rzp.qrCode.create({
          type: "upi_qr",
          name: `${BRAND_NAME} — ${formatINR(amountPaise)}`,
          usage: "single_use",
          fixed_amount: true,
          payment_amount: amountPaise,
          description: `${PRODUCT_NAME} — ${formatINR(amountPaise)} (${modeLabel})`,
          close_by: Math.floor(Date.now() / 1000) + Math.ceil(TIMEOUT_MS / 1000) + 30,
        }) as { id: string; image_url: string };
        sessionId = qr.id;
        const resp = await fetch(qr.image_url);
        if (!resp.ok) throw new Error(`image fetch HTTP ${resp.status}`);
        qrBuffer = await cropQrImage(Buffer.from(await resp.arrayBuffer()));
        logger.info({ qrId: qr.id, amountPaise }, "Fixed-amount QR created and cropped");

        // Test mode: also create a Razorpay payment link for browser-based payment
        if (mode === "test") {
          try {
            const link = await rzp.paymentLink.create({
              amount: amountPaise,
              currency: "INR",
              description: `${PRODUCT_NAME} — ${formatINR(amountPaise)} (test)`,
              expire_by: Math.floor(Date.now() / 1000) + 20 * 60,
              reminder_enable: false,
              notify: { sms: false, email: false },
            });
            webPayUrl = link.short_url;
            webPayLinkId = link.id;
            logger.info({ linkId: link.id }, "Test payment link created");
          } catch (linkErr) {
            logger.warn({ linkErr }, "Test payment link creation failed — QR only");
          }
        }
      } catch (rzpErr) {
        logger.error({ rzpErr }, "Razorpay QR creation failed");
        await bot.api.editMessageText(chatId, creating.message_id,
          `❌ <b>Failed to create payment QR.</b>\n<i>Check credentials and try again.</i>`,
          { parse_mode: "HTML" });
        return;
      }
    }

    try {
      await bot.api.deleteMessage(chatId, creating.message_id);
    } catch (err) {
      logger.debug({ err }, "deleteMessage (generating msg) skipped");
    }

    const endTime = Date.now() + TIMEOUT_MS;

    let sentMsg: { message_id: number };
    try {
      sentMsg = await bot.api.sendPhoto(
        chatId,
        new InputFile(qrBuffer, "upi-qr.png"),
        {
          caption: buildCaption(mode, amountPaise, "2:00"),
          parse_mode: "HTML",
          reply_markup: makeKeyboard(sessionId, webPayUrl),
        }
      );
    } catch (err) {
      logger.error({ err }, "Failed to send QR photo");
      await bot.api.sendMessage(chatId, `❌ Failed to send QR image. Please try again.`);
      return;
    }

    const session: Session = {
      chatId,
      messageId: sentMsg.message_id,
      linkId: sessionId,
      endTime,
      mode,
      amountPaise,
      pollIntervalId: null,
      countdownIntervalId: null,
      resolved: false,
      directUpi: isDirectUpi,
      sessionStartTs,
      webPayUrl,
      webPayLinkId,
      onPayment: async (paymentId, paidAmt) => {
        await handlePaymentReceived(session, paymentId, paidAmt);
      },
    };

    sessions.set(sessionId, session);

    session.countdownIntervalId = setInterval(async () => {
      if (session.resolved) {
        if (session.countdownIntervalId !== null) clearInterval(session.countdownIntervalId);
        return;
      }
      const rem = session.endTime - Date.now();
      if (rem <= 0) return;
      try {
        await bot.api.editMessageCaption(chatId, sentMsg.message_id, {
          caption: buildCaption(mode, amountPaise, formatTime(rem)),
          parse_mode: "HTML",
          reply_markup: makeKeyboard(sessionId, session.webPayUrl),
        });
      } catch (err) {
        logger.debug({ err }, "Caption edit skipped");
      }
    }, COUNTDOWN_INTERVAL_MS);

    session.pollIntervalId = setInterval(async () => {
      if (session.resolved) {
        if (session.pollIntervalId !== null) clearInterval(session.pollIntervalId);
        return;
      }
      if (Date.now() >= session.endTime) {
        if (session.pollIntervalId !== null) clearInterval(session.pollIntervalId);
        if (session.countdownIntervalId !== null) clearInterval(session.countdownIntervalId);
        await handleTimeout(session);
        return;
      }
      try {
        const match = await findMatchingPayment(session);
        if (session.resolved) return;
        if (match) {
          session.resolved = true;
          if (session.pollIntervalId !== null) clearInterval(session.pollIntervalId);
          if (session.countdownIntervalId !== null) clearInterval(session.countdownIntervalId);
          await handlePaymentReceived(session, match.id, match.amount);
        }
      } catch (err) {
        logger.warn({ err }, "Poll error (will retry)");
      }
    }, POLL_INTERVAL_MS);
  }

  // ── /start ────────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    const name = esc(ctx.from?.first_name ?? "there");

    // Use fully custom welcome message if set in env
    if (WELCOME_MESSAGE.trim()) {
      await ctx.reply(
        WELCOME_MESSAGE.replace(/\{name\}/g, name),
        { parse_mode: "HTML" }
      );
      return;
    }

    // Build auto-generated welcome
    const descLine = BOT_DESCRIPTION.trim()
      ? `\n<i>${esc(BOT_DESCRIPTION)}</i>\n`
      : "";

    const amtRange = LIMITS.real.min === LIMITS.real.max
      ? `₹${esc(formatINR(LIMITS.real.min).replace("₹","").trim())}`
      : `${esc(formatINR(LIMITS.real.min))} – ${esc(formatINR(LIMITS.real.max))}`;

    const testSection = DISABLE_TEST_MODE
      ? ""
      : `🧪 /test — Sandbox (safe to try, no real money)\n`;

    const supportLine = SUPPORT_CONTACT.trim()
      ? `\n💬 Support: ${esc(SUPPORT_CONTACT)}`
      : "";

    const testTip = DISABLE_TEST_MODE
      ? `\nSend /real to begin →`
      : `\n<b>Try it:</b> Send /test — use UPI ID <code>success@razorpay</code> to simulate a payment.\nSend /real when ready to accept real money.`;

    await ctx.reply(
      `👋 <b>${esc(BRAND_NAME)}</b>${descLine}\n\n` +
      `🏷️ <b>${esc(PRODUCT_NAME)}</b>\n` +
      `💰 Accepts: <b>${amtRange}</b>\n` +
      `\n<b>Commands</b>\n` +
      testSection +
      `🔴 /real — Pay with UPI (real money)\n` +
      `📋 /status — Active session info\n` +
      `❓ /help — How to use this bot\n` +
      `🚫 /cancel — Cancel current prompt` +
      supportLine +
      testTip,
      { parse_mode: "HTML" }
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────

  bot.command("help", async (ctx) => {
    const timeoutLabel = formatTime(TIMEOUT_MS);
    const testSection = DISABLE_TEST_MODE
      ? ""
      : `\n<b>Test mode (sandbox)</b>\n` +
        `Send /test → enter any amount → scan QR\n` +
        `• UPI ID <code>success@razorpay</code> → payment succeeds\n` +
        `• UPI ID <code>failure@razorpay</code> → payment fails\n` +
        `• Or tap <b>💻 Pay on Web</b> button for browser checkout\n`;

    const realSection =
      `\n<b>Live mode (real money)</b>\n` +
      `Send /real → enter amount → scan QR with any UPI app\n` +
      `• Enter amount in ₹ (e.g. <code>500</code> or <code>1500.50</code>)\n` +
      `• Google Pay, PhonePe, Paytm, BHIM — all work\n` +
      `• Amount is pre-filled — just tap Pay in your UPI app\n`;

    const supportLine = SUPPORT_CONTACT.trim()
      ? `\n💬 <b>Need help?</b> ${esc(SUPPORT_CONTACT)}`
      : "";

    await ctx.reply(
      `❓ <b>How to use ${esc(BRAND_NAME)}</b>\n` +
      `━━━━━━━━━━━━━━━━` +
      testSection +
      realSection +
      `\n<b>QR expires in</b> ${timeoutLabel} — scan before timer runs out.\n` +
      `Tap <b>🔍 Check Now</b> if you paid but bot hasn't confirmed yet.\n` +
      `Tap <b>❌ Cancel</b> to abort and start fresh.` +
      supportLine,
      { parse_mode: "HTML" }
    );
  });

  // ── /about ────────────────────────────────────────────────────────────────

  bot.command("about", async (ctx) => {
    const githubLine = GITHUB_URL.trim()
      ? `\n🔗 <a href="${esc(GITHUB_URL)}">View source on GitHub</a> — open source, MIT license\n` +
        `Fork it, customize it, make it your own.`
      : `\n💡 This bot is built with <b>Node.js + grammY + Razorpay</b>.\n` +
        `Fully customizable for any seller collecting UPI payments.`;

    await ctx.reply(
      `ℹ️ <b>About ${esc(BRAND_NAME)}</b>\n\n` +
      `A UPI payment bot powered by Razorpay.\n` +
      `Accepts payments via QR code — any UPI app works.\n` +
      `Instant confirmation via webhook.` +
      githubLine,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  });

  // ── Shared mode command logic ─────────────────────────────────────────────

  async function handleModeCommand(ctx: Context, requestedMode: PaymentMode): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const cmd = requestedMode === "test" ? "/test" : "/real";
    const modeLabel = requestedMode === "test" ? "test" : "live";
    const otherCmd = requestedMode === "test" ? "/real" : "/test";
    const otherLabel = requestedMode === "test" ? "live" : "test";

    // ── PENDING_AMOUNT conflict check ───────────────────────────────────────
    const pending = pendingInputs.get(chatId);
    if (pending) {
      if (pending.mode === requestedMode) {
        await ctx.reply(
          `🔁 Already setting up a <b>${modeLabel}</b> payment.\n\n` +
          `Just send the amount (e.g. <code>50</code>) to continue, or /cancel to abort.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `🚫 Can't switch to <b>${modeLabel}</b> — a <b>${otherLabel}</b> setup is in progress.\n\n` +
          `/cancel to abort it, then use ${cmd}.`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // ── ACTIVE_SESSION conflict check ───────────────────────────────────────
    const active = getActiveSessionByChatId(chatId);
    if (active) {
      const rem = active.endTime - Date.now();
      const activeBadge = active.mode === "test" ? "🧪 Test" : "🔴 Live";
      if (active.mode === requestedMode) {
        await ctx.reply(
          `⏳ <b>${activeBadge} QR is active</b> (${formatTime(rem)} left)\n\n` +
          `Press ❌ on the QR to cancel it before starting a new one.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `🚫 Can't switch to <b>${modeLabel}</b> — <b>${activeBadge} QR is active</b> (${formatTime(rem)} left)\n\n` +
          `Press ❌ Cancel on the QR first, then use ${cmd}.`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // ── Live keys check (only for /real) ────────────────────────────────────
    if (requestedMode === "real" && !rzpLive) {
      await ctx.reply(
        `⚠️ <b>Live keys not configured</b>\n\n` +
        `Add <code>RAZORPAY_LIVE_KEY_ID</code> and <code>RAZORPAY_LIVE_KEY_SECRET</code>\n` +
        `to the Secrets panel to enable live mode.\n\n` +
        `Use /test for sandbox mode (no real money).`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── State is IDLE — enter PENDING_AMOUNT ─────────────────────────────────
    pendingInputs.set(chatId, { mode: requestedMode });

    const limits = LIMITS[requestedMode];
    const minStr = esc(formatINR(limits.min));
    const maxStr = esc(formatINR(limits.max));

    if (requestedMode === "real") {
      await ctx.reply(
        `⚠️ <b>LIVE MODE</b> — real UPI money will move\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `💸 Range: ${minStr} – ${maxStr}\n\n` +
        `How much ₹? (e.g. <code>500</code> or <code>1500.50</code>)\n` +
        `Or /cancel to abort.`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(
        `🧪 <b>Test Mode</b> — no real money moves\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `💸 Range: ${minStr} – ${maxStr}\n\n` +
        `How much ₹? (e.g. <code>50</code> or <code>1500.50</code>)\n` +
        `Or /cancel to abort.\n\n` +
        `<i>Tip: After scanning, use UPI ID <code>success@razorpay</code> to simulate payment.</i>`,
        { parse_mode: "HTML" }
      );
    }
  }

  bot.command("test", async (ctx) => {
    if (DISABLE_TEST_MODE) {
      await ctx.reply(
        `ℹ️ Test mode is disabled. Use /real for payments.`,
        { parse_mode: "HTML" }
      );
      return;
    }
    return handleModeCommand(ctx, "test");
  });
  bot.command("real", (ctx) => handleModeCommand(ctx, "real"));

  // ── /cancel ───────────────────────────────────────────────────────────────

  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat.id;
    const pending = pendingInputs.get(chatId);

    if (!pending) {
      const active = getActiveSessionByChatId(chatId);
      if (active) {
        await ctx.reply(
          `ℹ️ A QR session is active — use the <b>❌ Cancel</b> button on the QR image to stop it.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `ℹ️ Nothing to cancel. Send /test or /real to start.`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    clearPendingInput(chatId);
    const badge = pending.mode === "test" ? "🧪 test" : "🔴 live";
    await ctx.reply(
      `✅ <b>${badge} setup cancelled.</b>\n\nSend /test or /real whenever you're ready.`,
      { parse_mode: "HTML" }
    );
  });

  // ── /status ───────────────────────────────────────────────────────────────

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const active = getActiveSessionByChatId(chatId);
    const pending = pendingInputs.get(chatId);

    if (active) {
      const rem = active.endTime - Date.now();
      const badge = active.mode === "test" ? "🧪 Test" : "🔴 Live";
      await ctx.reply(
        `📋 <b>Status: Active Session</b>\n\n` +
        `Mode: <b>${badge}</b>\n` +
        `Amount: <b>${esc(formatINR(active.amountPaise))}</b>\n` +
        `Time left: <b>${formatTime(rem)}</b>\n\n` +
        `Use the ❌ Cancel button on the QR to stop it.`,
        { parse_mode: "HTML" }
      );
    } else if (pending) {
      const badge = pending.mode === "test" ? "🧪 Test" : "🔴 Live";
      await ctx.reply(
        `📋 <b>Status: Waiting for Amount</b>\n\n` +
        `Mode: <b>${badge}</b>\n` +
        `Just send the amount to continue, or /cancel to abort.`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(
        `📋 <b>Status: Idle</b>\n\nNo active session. Send /test or /real to start.`,
        { parse_mode: "HTML" }
      );
    }
  });

  // ── Inline button: Check Now ──────────────────────────────────────────────

  bot.callbackQuery(/^check:(.+)$/, async (ctx) => {
    const linkId = ctx.match[1];
    const session = sessions.get(linkId);

    if (!session || session.resolved) {
      await ctx.answerCallbackQuery({ text: "Session is no longer active." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "🔍 Checking Razorpay..." });
    const paid = await forceCheckPayment(session);

    if (!paid) {
      try {
        const rem = session.endTime - Date.now();
        await ctx.editMessageCaption({
          caption: buildCaption(
            session.mode,
            session.amountPaise,
            formatTime(rem),
            `<i>Checked — no payment found yet, still watching</i>`
          ),
          parse_mode: "HTML",
          reply_markup: makeKeyboard(linkId, session.webPayUrl),
        });
      } catch (err) {
        logger.debug({ err }, "Check feedback edit skipped");
      }
    }
  });

  // ── Inline button: Cancel ─────────────────────────────────────────────────

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const linkId = ctx.match[1];
    const session = sessions.get(linkId);

    if (!session || session.resolved) {
      await ctx.answerCallbackQuery({ text: "Session already closed." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "❌ Cancelling..." });
    session.resolved = true;
    await cleanupSession(session, true);
    await deleteQR(session, "cancel button");

    const nextCmd = session.mode === "test" ? "/test" : "/real";
    await bot.api.sendMessage(
      session.chatId,
      `❌ <b>Session Cancelled</b>\n\nSend ${nextCmd} to start a new one.`,
      { parse_mode: "HTML" }
    );
  });

  // ── Message handler — intercepts amount input in PENDING_AMOUNT state ─────

  bot.on("message", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = "text" in ctx.message ? (ctx.message.text ?? "") : "";

    if (text.startsWith("/")) return;

    const pending = pendingInputs.get(chatId);
    if (!pending) {
      await ctx.reply(
        `<i>Use /test or /real to generate a payment QR code</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const paise = parseAmountPaise(text);
    const limits = LIMITS[pending.mode];

    if (paise === null) {
      await ctx.reply(
        `❌ <b>Invalid amount</b> — enter a number like <code>50</code> or <code>1500.50</code>.\n` +
        `<i>Or /cancel to abort.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (paise < limits.min) {
      await ctx.reply(
        `❌ <b>Too low</b> — minimum is ${esc(formatINR(limits.min))}.\n` +
        `<i>Send a valid amount or /cancel to abort.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (paise > limits.max) {
      const limitLabel = pending.mode === "real" ? "UPI" : "test";
      await ctx.reply(
        `❌ <b>Too high</b> — ${limitLabel} maximum is ${esc(formatINR(limits.max))}.\n` +
        `<i>Send a valid amount or /cancel to abort.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const mode = pending.mode;
    clearPendingInput(chatId);

    try {
      await startPaymentSession(chatId, mode, paise);
    } catch (err) {
      logger.error({ err }, "startPaymentSession error");
      pendingInputs.set(chatId, { mode });
      await ctx.reply(
        `❌ <b>Something went wrong.</b> Please try again or /cancel to abort.`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update }, "Unhandled bot error");
  });

  // ── Register bot commands in Telegram's command menu ──────────────────────
  // This makes commands show as suggestions when the user types "/" in the chat.
  // Update this list whenever you add/remove commands.
  {
    const cmds: Array<{ command: string; description: string }> = [];
    if (!DISABLE_TEST_MODE) {
      cmds.push({ command: "test", description: "🧪 Test payment (sandbox, no real money)" });
    }
    cmds.push(
      { command: "real",   description: "🔴 Pay via UPI (real money)" },
      { command: "status", description: "📋 Check active session" },
      { command: "cancel", description: "🚫 Cancel current prompt" },
      { command: "help",   description: "❓ How to use this bot" },
      { command: "about",  description: "ℹ️ About this bot" }
    );
    bot.api.setMyCommands(cmds).catch((err) =>
      logger.warn({ err }, "setMyCommands failed — non-fatal")
    );
  }

  // Webhook mode — no 409 conflicts, Telegram pushes updates to us
  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/telegram/webhook`
      : null);

  if (webhookUrl) {
    // Init bot first so handleUpdate works, then register webhook
    bot.init().then(() =>
      bot.api.setWebhook(webhookUrl, { drop_pending_updates: true })
    ).then(() => {
      logger.info({ webhookUrl }, "Telegram webhook registered — bot ready");
      (globalThis as Record<string, unknown>)._telegramBot = bot;
    }).catch((err) => {
      logger.error({ err }, "Failed to initialise/register Telegram webhook");
    });
    logger.info("Telegram bot running in webhook mode");
  } else {
    // Fallback: long polling with retry
    async function startWithRetry(attempt = 1): Promise<void> {
      try {
        await bot.start({
          onStart: (info) =>
            logger.info({ username: info.username }, "Telegram bot started (long polling)"),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") || msg.includes("Conflict")) {
          const delay = Math.min(35_000, attempt * 10_000);
          logger.warn({ attempt, delay }, "Bot 409 conflict — retrying after delay");
          await new Promise((r) => setTimeout(r, delay));
          return startWithRetry(attempt + 1);
        }
        logger.error({ err }, "Bot start failed");
        throw err;
      }
    }
    startWithRetry();
  }
}
