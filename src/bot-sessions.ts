// =============================================================================
// bot-sessions.ts — SESSION STATE + WEBHOOK BRIDGE
// =============================================================================
//
// AI QUICK REFERENCE:
//   • sessions Map     — all active payment sessions, keyed by Razorpay QR ID
//   • pendingInputs    — users who have sent /real or /test but not yet an amount
//   • Session type     — full data for an active payment (chatId, amount, timer, etc.)
//   • notifyPaymentLinkPaid() — called by webhook handler when Razorpay confirms payment
//                               → finds the session → fires session.onPayment()
//
// HOW SESSIONS ARE KEYED:
//   session.linkId = Razorpay QR code ID (e.g. qr_AbCd1234)
//   sessions.set(qr.id, session)      ← set in bot.ts startPaymentSession()
//   sessions.get(qrCode.id)           ← looked up in notifyPaymentLinkPaid()
//
// SESSION IS REMOVED when:
//   • Payment confirmed → cleanupSession(session, false)
//   • User cancels     → cleanupSession(session, true)  ← also closes QR on Razorpay
//   • Timer expires    → handleTimeout() → cleanupSession(session, true)
//
// =============================================================================

export type PaymentMode = "test" | "real";

export interface PendingInput {
  mode: PaymentMode;
}

export interface Session {
  chatId: number;
  messageId: number;
  linkId: string;
  endTime: number;
  mode: PaymentMode;
  amountPaise: number;
  pollIntervalId: ReturnType<typeof setInterval> | null;
  countdownIntervalId: ReturnType<typeof setInterval> | null;
  resolved: boolean;
  onPayment: (paymentId: string, amountPaise: number) => Promise<void>;
  /** true when using direct upi:// QR instead of Razorpay QR code/payment link */
  directUpi: boolean;
  /** unix seconds — used to filter payments by time */
  sessionStartTs: number;
  /** Razorpay QR code ID — used for fetchAllPayments (may differ from linkId for persistent QRs) */
  qrId?: string;
  /** Web payment URL shown as button (test mode only) */
  webPayUrl?: string;
  /** Razorpay payment link ID for web pay (test mode) — used for webhook detection */
  webPayLinkId?: string;
}

/** ACTIVE_SESSION state — keyed by session ID */
export const sessions = new Map<string, Session>();

/** PENDING_AMOUNT state — keyed by chatId */
export const pendingInputs = new Map<number, PendingInput>();

/** Look up an active (unresolved) session by chatId */
export function getActiveSessionByChatId(chatId: number): Session | undefined {
  for (const session of sessions.values()) {
    if (session.chatId === chatId && !session.resolved) return session;
  }
  return undefined;
}

/** Clear pending amount input for a chatId */
export function clearPendingInput(chatId: number): void {
  pendingInputs.delete(chatId);
}

export function notifyPaymentLinkPaid(
  linkId: string,
  paymentId: string,
  amountPaise: number
): void {
  // First: direct linkId lookup (legacy payment links)
  let session = sessions.get(linkId);

  // Fallback: search by qrId or webPayLinkId
  if (!session || session.resolved) {
    for (const s of sessions.values()) {
      if (!s.resolved && (s.qrId === linkId || s.webPayLinkId === linkId)) {
        session = s;
        break;
      }
    }
  }

  if (!session || session.resolved) return;
  session.resolved = true;
  clearPendingInput(session.chatId);
  session.onPayment(paymentId, amountPaise).catch(() => {});
}
