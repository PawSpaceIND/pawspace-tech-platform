import type { AtlasBusinessSnapshot } from './atlas-business-snapshot';

export const ATLAS_ANSWER_SCOPE = {
  mode: 'UAT only; recommendations never prove execution',
  internalArtifacts: ['brief.generate', 'report.generate', 'task.draft', 'followup.draft', 'case.recommend', 'training.recommend'],
  conditions: 'Internal artifacts may run only within the configured autonomy envelope, quotas and circuit breaker. This snapshot does not prove a particular action ran.',
  humanGated: ['payment capture', 'refund', 'payout', 'provider assignment', 'customer outreach', 'campaign activation', 'HR/legal decisions'],
  restrictions: 'No consent, DND, quiet-hours, MFA, production-readiness or approval bypass. Founder-approved campaign activation uses its existing governed gateway.',
} as const;

export function atlasDraftCompletionFailure(stopReason: string | null): string | null {
  return ['max_tokens', 'length', 'incomplete', 'content_filter', 'refusal'].includes(String(stopReason).toLowerCase())
    ? 'narrative_incomplete' : null;
}
const clean = (value: string) => value.replace(/[*_`|]/g, ' ').replace(/[\t ]+/g, ' ');
const magnitude = (value: string, unit: string) => Number(value.replaceAll(',', '')) *
  ({ k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, million: 1e6, billion: 1e9 }[unit.toLowerCase()] || 1);

/** Checks every matched financial claim, including markdown/table and percentage forms.
 * This is conservative validation, not a claim to solve arbitrary-language factuality.
 */
export function atlasFinancialClaimsFit(snapshot: AtlasBusinessSnapshot, narrative: string) {
  const text = clean(narrative), mission = snapshot.mission.value;
  const labels = ['achieved', 'collected', 'net', 'booked', 'target'] as const;
  for (const label of labels) {
    const pattern = new RegExp('\\b' + label + '(?:\\s+(?:revenue|amount|percentage|percent))?\\s*(?:is|=|:|at|of|\\u2014|\\u2013)?\\s*(?:%\\s*)?(?:INR|Rs\\.?|\\u20b9)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(%|percent|lakh[s]?|lac[s]?|crore[s]?|million|billion|thousand|k)?', 'gi');
    for (const match of text.matchAll(pattern)) {
      if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
      const percent = ['%', 'percent'].includes((match[2] || '').toLowerCase()) || /percentage|percent|%/i.test(match[0].split(match[1])[0]);
      const expected = percent ? mission.percent : label === 'achieved' ? mission.net : mission[label];
      const actual = magnitude(match[1], match[2] || '');
      if (!Number.isFinite(actual) || actual > expected + 0.01 || (label === 'target' && !percent && Math.abs(actual - expected) > 0.01))
        return { ok: false as const, reason: label === 'achieved' || percent ? 'narrative_overstates_achievement' : label === 'target' ? 'narrative_changes_target' : `narrative_overstates_${label}` };
    }
  }
  for (const match of text.matchAll(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:%|percent)\s*(?:of\s+(?:the\s+)?target|achieved|achievement)/gi)) {
    if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
    if (Number(match[1]) > mission.percent + 0.01) return { ok: false as const, reason: 'narrative_overstates_achievement' };
  }
  for (const match of text.matchAll(/(?:INR|Rs\.?|\u20b9)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh[s]?|lac[s]?|crore[s]?|million|billion|thousand|k)?\s+(?:was\s+|has\s+been\s+)?(collected|booked|achieved)\b/gi)) {
    if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
    const key = match[3].toLowerCase(), expected = key === 'achieved' ? mission.net : key === 'collected' ? mission.collected : mission.booked;
    if (magnitude(match[1], match[2] || '') > expected + 0.01) return { ok: false as const, reason: key === 'achieved' ? 'narrative_overstates_achievement' : `narrative_overstates_${key}` };
  }
  if ((!mission || mission.net < mission.target) && /target (?:is )?(?:fully )?(?:achieved|met)|achieved the full target/i.test(text))
    return { ok: false as const, reason: 'narrative_overstates_achievement' };
  return { ok: true as const };
}

export function atlasOperationalFacts(snapshot: AtlasBusinessSnapshot): string {
  const metric = (name: string, item: { value: unknown; source: string; reason?: string }) =>
    `${name}: ${item.value === null ? `unknown (${item.reason || 'unavailable'})` : JSON.stringify(item.value)}. Source: ${item.source}.`;
  return [`Snapshot as of ${new Date(snapshot.asOf).toISOString()}.`,
    metric('Open cases', snapshot.ops.open_cases), metric('SLA breaches', snapshot.ops.sla_breaches),
    metric('Sitting pending acceptance', snapshot.ops.sitting_pending_accepts), metric('Boarding pending acceptance', snapshot.ops.boarding_pending_accepts),
    metric('Completed-job invoice gap', snapshot.finance.invoice_completed_gap), metric('Trainer earnings readiness', snapshot.finance.trainer_earnings),
    'Recommendations and internal drafts are not external actions. Payments, refunds, payouts, provider assignment and outreach remain governed.',
  ].join('\n');
}
