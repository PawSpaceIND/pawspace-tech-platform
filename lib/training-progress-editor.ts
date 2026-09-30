export const TRAINING_PROGRESS_KEYS = ["focus", "recall", "impulse", "parent"] as const;
export type TrainingProgressScores = Record<string, number | null>;
/** Missing assessments stay unassessed; retain recorded numeric scores, including legacy categories and zero. */
export function trainingProgressFromRecord(progress: Record<string, unknown> = {}): TrainingProgressScores {
  const keys = [...new Set([...TRAINING_PROGRESS_KEYS, ...Object.keys(progress)])];
  return Object.fromEntries(keys.map(key => [key,
    typeof progress[key] === "number" && Number.isFinite(progress[key]) ? progress[key] : null,
  ]));
}
/** Preserve the existing policy: at least one explicit 1–10 score, not four mandatory assessments. */
export function trainingProgressReady(scores: TrainingProgressScores): boolean {
  const entered = Object.values(scores).filter(score => score !== null);
  return entered.length > 0 && entered.every(score => typeof score === "number" && Number.isFinite(score) && score >= 1 && score <= 10);
}
