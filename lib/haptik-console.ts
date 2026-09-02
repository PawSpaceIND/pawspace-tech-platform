/**
 * Pure decision helpers for the Haptik operator console.
 *
 * The console can cause real phones to ring, so the rules about when that is offered are kept here,
 * out of the markup, and executed by tests - the same reason lib/voice-operator-console.ts exists. The
 * page renders the decision; it does not make it.
 *
 * Two properties these functions exist to hold:
 *
 *   A launch is never the first click. An operator has to preview the audience for the campaign they
 *   are about to dial, and the preview is held together with the campaign and limit it was run for, so
 *   previewing 20 lapsed customers cannot authorise dialling 5,000 of them.
 *
 *   The console cannot turn calling on. Whether Haptik outbound is connected at all is decided by the
 *   environment; these helpers only read that and disable themselves to match, stating the reason
 *   rather than letting a button do nothing.
 */

export type ConsoleReadiness = { campaign: string; label: string; requiresMarketingConsent: boolean; ready: number; refreshedAt: number | null };
export type AudiencePreview = { campaign: string; limit: number; size: number; at: number };
export type LaunchDecision = { allowed: boolean; blockedBy: string | null; detail: string | null };

/** True when the held preview is for exactly the campaign and limit now on screen. */
export function previewMatchesCampaign(preview: AudiencePreview | null, campaign: string, limit: number): boolean {
  if (!preview) return false;
  return preview.campaign === campaign && preview.limit === limit;
}

export function campaignLaunchDecision(input: {
  connected: boolean;
  connectionReason?: string | null;
  campaign: string;
  limit: number;
  preview: AudiencePreview | null;
  quietHours: boolean;
}): LaunchDecision {
  if (!input.connected) return { allowed: false, blockedBy: "not_connected", detail: input.connectionReason || "Haptik outbound is not connected. No calls can be placed." };
  if (!input.campaign) return { allowed: false, blockedBy: "no_campaign", detail: "Choose a campaign." };
  if (!Number.isFinite(input.limit) || input.limit < 1) return { allowed: false, blockedBy: "invalid_limit", detail: "Set how many contacts this run may call." };
  if (!previewMatchesCampaign(input.preview, input.campaign, input.limit)) return { allowed: false, blockedBy: "preview_required", detail: "Preview this campaign's audience at this limit before launching." };
  if (input.preview && input.preview.size === 0) return { allowed: false, blockedBy: "empty_audience", detail: "Nobody is currently eligible for this campaign." };
  // Quiet hours does not block the button - the API refuses the run and the override is separately
  // permission-gated and reason-coded. Saying so here is more honest than a disabled button with no
  // explanation, and the operator still cannot dial through it from this page.
  if (input.quietHours) return { allowed: false, blockedBy: "quiet_hours", detail: "Quiet hours (21:00-09:00 IST). Calls resume at 09:00." };
  return { allowed: true, blockedBy: null, detail: null };
}

/**
 * One line per gap, in the order it has to be closed, for the readiness banner. An empty list means
 * the WhatsApp half of every journey can actually complete.
 */
export function interaktSetupGaps(input: { connected: boolean; links: Array<{ linkKey: string; label: string; linkConfigured: boolean; templateApproved: boolean }> }): string[] {
  const gaps: string[] = [];
  if (!input.connected) gaps.push("Interakt is not connected (INTERAKT_API_KEY / INTERAKT_BASE_URL).");
  for (const link of input.links) {
    if (!link.linkConfigured) gaps.push(`${link.label}: no link configured.`);
    else if (!link.templateApproved) gaps.push(`${link.label}: no approved WhatsApp template.`);
  }
  return gaps;
}
