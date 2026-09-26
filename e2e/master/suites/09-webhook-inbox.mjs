// Read-only: are any Razorpay webhooks stuck unprocessed on staging since the live deploy? (PAY-01 regression watch)
// Webhooks from before the deploy that the old code left in PROCESSING are counted, not failed; in-flight ones get
// two minutes to settle.
import { mkdirSync } from "node:fs";
import { OUT, writeJson, recordWebhookCheck } from "../lib.mjs";

mkdirSync(OUT, { recursive: true });
writeJson("webhook-inbox.json", await recordWebhookCheck("09-webhook-inbox"));
