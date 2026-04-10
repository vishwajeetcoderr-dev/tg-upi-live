import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { razorpayWebhookHandler } from "./routes/razorpay-webhook.js";
import { logger } from "./lib/logger.js";
import type { Bot } from "grammy";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors());

app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  razorpayWebhookHandler
);

// Telegram webhook — receives updates pushed by Telegram (webhook mode, no 409 conflicts)
app.post(
  "/api/telegram/webhook",
  express.json(),
  (req: Request, res: Response) => {
    const bot = (globalThis as Record<string, unknown>)._telegramBot as Bot | undefined;
    if (!bot) {
      res.status(503).json({ error: "Bot not initialised" });
      return;
    }
    bot.handleUpdate(req.body).then(() => res.sendStatus(200)).catch((err) => {
      logger.error({ err }, "Error handling Telegram update");
      res.sendStatus(500);
    });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
