// =============================================================================
// razorpay-webhook.ts — INSTANT PAYMENT DETECTION VIA WEBHOOK
// =============================================================================
//
// AI QUICK REFERENCE:
//   Endpoint: POST /api/razorpay/webhook
//   Security: HMAC-SHA256 with RAZORPAY_WEBHOOK_SECRET (timingSafeEqual)
//
// RAZORPAY DASHBOARD SETUP (Settings → Webhooks → Add New Webhook):
//   URL:    https://yourdomain.com/api/razorpay/webhook
//   Secret: same value as RAZORPAY_WEBHOOK_SECRET in your .env
//   Events to enable:
//     ✅ qr_code.credited   — primary: UPI payment received on QR
//     ✅ payment.captured   — backup: live mode payment with qr_code_id in payload
//     ✅ payment_link.paid  — test mode Pay-on-Web checkout
//
// EVENT FLOW:
//   Razorpay → POST /api/razorpay/webhook
//     → verify HMAC signature
//     → parse event type
//     → extract QR code ID + payment ID + amount
//     → call notifyPaymentLinkPaid(qrId, paymentId, amount)
//     → notifyPaymentLinkPaid finds session in sessions Map
//     → fires session.onPayment(paymentId, amount)
//     → handlePaymentReceived() in bot.ts runs
//
// NOTE: If webhook is not configured, polling fallback (every 1.5s) handles detection.
//
// =============================================================================

import crypto from "crypto";
import type { RequestHandler } from "express";
import { notifyPaymentLinkPaid } from "../bot.js";
import { logger } from "../lib/logger.js";

interface WebhookPayment {
  id: string;
  amount: number;
  qr_code_id?: string;
  status?: string;
}

interface WebhookQrCode {
  id: string;
  status: string;
}

interface WebhookPaymentLink {
  id: string;
  status: string;
}

interface RazorpayWebhookBody {
  event: string;
  payload?: {
    payment?: { entity?: WebhookPayment };
    qr_code?: { entity?: WebhookQrCode };
    payment_link?: { entity?: WebhookPaymentLink };
  };
}

export const razorpayWebhookHandler: RequestHandler = (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const rawBody = req.body as Buffer;
  const signature = req.headers["x-razorpay-signature"];

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      logger.error("RAZORPAY_WEBHOOK_SECRET not set in production — rejecting webhook");
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }
    logger.warn("RAZORPAY_WEBHOOK_SECRET not set — skipping signature check (dev only)");
  } else {
    if (typeof signature !== "string") {
      if (process.env.NODE_ENV === "production") {
        req.log.warn("Razorpay webhook: missing signature — rejected (production)");
        res.status(400).json({ error: "Missing signature header" });
        return;
      }
      // Dev/test: Razorpay dashboard may not have the secret configured yet — process anyway
      req.log.warn(
        "Razorpay webhook: missing X-Razorpay-Signature — processing without verification (dev mode). " +
        "Set the webhook secret in Razorpay dashboard to match RAZORPAY_WEBHOOK_SECRET for production."
      );
    } else {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      const sigBuf = Buffer.from(signature, "utf8");
      const expBuf = Buffer.from(expected, "utf8");

      if (
        sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)
      ) {
        req.log.warn({ signature }, "Razorpay webhook: invalid HMAC signature");
        res.status(400).json({ error: "Invalid signature" });
        return;
      }
    }
  }

  let event: RazorpayWebhookBody;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookBody;
  } catch (err) {
    logger.warn({ err }, "Razorpay webhook: failed to parse JSON body");
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  req.log.info({ event: event.event }, "Razorpay webhook received");

  // UPI QR Code payment — primary flow (no browser redirect)
  if (event.event === "qr_code.credited") {
    const qrCode = event.payload?.qr_code?.entity;
    const payment = event.payload?.payment?.entity;

    if (qrCode?.id && payment?.id) {
      req.log.info(
        { qrCodeId: qrCode.id, paymentId: payment.id, amount: payment.amount },
        "QR code credited via webhook"
      );
      notifyPaymentLinkPaid(qrCode.id, payment.id, payment.amount);
    } else {
      req.log.info({ payload: event.payload }, "qr_code.credited — missing entities");
    }
  }

  // payment.captured — fires for QR payments in live mode (has qr_code_id field)
  if (event.event === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (payment?.id && payment.qr_code_id) {
      req.log.info(
        { qrCodeId: payment.qr_code_id, paymentId: payment.id, amount: payment.amount },
        "payment.captured for QR — notifying session"
      );
      notifyPaymentLinkPaid(payment.qr_code_id, payment.id, payment.amount);
    }
  }

  // Legacy: payment link paid (kept for backwards compatibility)
  if (event.event === "payment_link.paid") {
    const paymentLink = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;

    if (paymentLink?.id && payment?.id) {
      req.log.info(
        { linkId: paymentLink.id, paymentId: payment.id, amount: payment.amount },
        "Payment link paid via webhook"
      );
      notifyPaymentLinkPaid(paymentLink.id, payment.id, payment.amount);
    } else {
      req.log.info({ payload: event.payload }, "payment_link.paid — missing entities");
    }
  }

  res.status(200).json({ received: true });
};
