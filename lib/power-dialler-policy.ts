export const POWER_DIALLER_AUTO_ADVANCE_MS = 2500;
export const POWER_DIALLER_MAX_NO_ANSWER_ATTEMPTS = 3;
export const POWER_DIALLER_NO_ANSWER_RETRY_MS = 2 * 60 * 60_000;
export const POWER_DIALLER_NOT_INTERESTED_COOLDOWN_MS = 30 * 86_400_000;

export const POWER_DIALLER_DISPOSITIONS = [
  "interested",
  "booked",
  "callback",
  "no_answer",
  "not_interested",
  "wrong_number",
  "dnd",
] as const;

export type PowerDiallerDispositionCode = typeof POWER_DIALLER_DISPOSITIONS[number];

export function shouldAutoAdvance(disposition: string) {
  return (POWER_DIALLER_DISPOSITIONS as readonly string[]).includes(disposition);
}
