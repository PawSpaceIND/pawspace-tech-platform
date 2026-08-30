-- A canonical booking payment can legitimately open more than one gateway order (for example,
-- the first and outstanding stages of a 50/50 stay). Scoped checkout idempotency remains enforced by
-- payment_intents(customer_id, booking_id, idempotency_key); payment_id is a lookup key, not an identity.
DROP INDEX IF EXISTS idx_payment_intents_payment_id;
CREATE INDEX IF NOT EXISTS idx_payment_intents_payment_id ON payment_intents(payment_id);
