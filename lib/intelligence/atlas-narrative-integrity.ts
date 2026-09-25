import type { AtlasBusinessSnapshot } from './atlas-business-snapshot';

export const ATLAS_ANSWER_SCOPE = {
  mode: 'UAT only; recommendations never prove execution',
  internalArtifacts: ['brief.generate', 'report.generate', 'task.draft', 'followup.draft', 'case.recommend', 'training.recommend'],
  conditions: 'Internal artifacts may run only within the configured autonomy envelope, quotas and circuit breaker. This snapshot does not prove a particular action ran.',
  humanGated: ['payment capture', 'refund', 'payout', 'provider assignment', 'customer outreach', 'campaign activation', 'HR/legal decisions'],
  restrictions: 'No consent, DND, quiet-hours, MFA, production-readiness or approval bypass. Founder-approved campaign activation uses its existing governed gateway.',
} as const;

export function atlasDraftCompletionFailure(stopReason: string | null): string | null {
  // Unknown termination is not proof of a complete answer. No automatic re-generation.
  return ['end_turn', 'completed', 'stop'].includes(String(stopReason).toLowerCase())
    ? null : 'narrative_incomplete';
}
const clean = (value: string) => value.replace(/[*_`|]/g, ' ').replace(/[\t ]+/g, ' ');
const magnitude = (value: string, unit: string) => Number(value.replaceAll(',', '')) *
  ({ k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7, million: 1e6, billion: 1e9 }[unit.toLowerCase()] || 1);

const unsupportedFinancialSyntax = (text: string) =>
  /\b(?:achievement|achieved|collected|net(?:\s+collected)?|booked|target)\b[^.;\n]{0,40}(?:-|\+)\s*\d/i.test(text) ||
  /\b(?:achievement|achieved|collected|net(?:\s+collected)?|booked|target)\b[^.;\n]{0,40}\d+(?:\.\d+)?e[+-]?\d+/i.test(text) ||
  /\b(?:achievement|achieved|collected|net(?:\s+collected)?|booked|target)\b[^.;\n]{0,40}(?:INR|Rs\.?|\u20b9)?\s*\d+(?:\.\d+)?\s*m\b/i.test(text) ||
  /(?:INR|Rs\.?|\u20b9)?\s*\d+(?:\.\d+)?\s*m\b[^.;\n]{0,32}\b(?:achievement|achieved|collected|net(?:\s+collected)?|booked|target)\b/i.test(text);

/** Checks every matched financial claim, including markdown/table and percentage forms.
 * This is conservative validation, not a claim to solve arbitrary-language factuality.
 */
export function atlasFinancialClaimsFit(snapshot: AtlasBusinessSnapshot, narrative: string) {
  const text = clean(narrative), mission = snapshot.mission.value;
  if (unsupportedFinancialSyntax(text))
    return { ok: false as const, reason: 'narrative_unsupported_financial_format' };

  const labels = [
    { name: 'achieved', pattern: '(?:achieved|achievement)' },
    { name: 'collected', pattern: 'collected' },
    { name: 'net', pattern: 'net(?:\\s+collected)?' },
    { name: 'booked', pattern: 'booked' },
    { name: 'target', pattern: 'target' },
  ] as const;

  for (const label of labels) {
    const pattern = new RegExp('\\b' + label.pattern + '\\b(?:\\s+(?:revenue|amount|percentage|percent))?\\s*(?:\\(\\s*%\\s*\\))?\\s*(?:is|=|:|at|of|\\u2014|\\u2013)?\\s*(?:%\\s*)?(?:INR|Rs\\.?|\\u20b9)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(%|percent|lakh[s]?|lac[s]?|cr|crore[s]?|million|billion|thousand|k)?', 'gi');
    for (const match of text.matchAll(pattern)) {
      if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
      const percent = ['%', 'percent'].includes((match[2] || '').toLowerCase()) || /percentage|percent|%/i.test(match[0].split(match[1])[0]);
      const expected = percent ? mission.percent : label.name === 'achieved' ? mission.net : mission[label.name];
      const actual = magnitude(match[1], match[2] || '');
      if (!Number.isFinite(actual) || actual > expected + 0.01 || (label.name === 'target' && !percent && Math.abs(actual - expected) > 0.01))
        return { ok: false as const, reason: label.name === 'achieved' || percent ? 'narrative_overstates_achievement' : label.name === 'target' ? 'narrative_changes_target' : `narrative_overstates_${label.name}` };
    }
  }

  for (const match of text.matchAll(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:%|percent)\s*(?:of\s+(?:the\s+)?target|achieved|achievement)/gi)) {
    if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
    if (Number(match[1]) > mission.percent + 0.01) return { ok: false as const, reason: 'narrative_overstates_achievement' };
  }

  for (const match of text.matchAll(/(?:INR|Rs\.?|\u20b9)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh[s]?|lac[s]?|cr|crore[s]?|million|billion|thousand|k)?\s+(?:was\s+|has\s+been\s+)?(collected|booked|achieved|achievement|target|net(?:\s+collected)?)\b/gi)) {
    if (!mission) return { ok: false as const, reason: 'narrative_invents_missing_mission' };
    const rawKey = match[3].toLowerCase(), key = rawKey === 'achievement' ? 'achieved' : rawKey.startsWith('net') ? 'net' : rawKey;
    const expected = key === 'achieved' ? mission.net : mission[key as 'collected'|'booked'|'target'|'net'];
    const actual = magnitude(match[1], match[2] || '');
    if (actual > expected + 0.01 || (key === 'target' && Math.abs(actual - expected) > 0.01))
      return { ok: false as const, reason: key === 'achieved' ? 'narrative_overstates_achievement' : key === 'target' ? 'narrative_changes_target' : `narrative_overstates_${key}` };
  }

  if ((!mission || mission.net < mission.target) && /target (?:is )?(?:fully )?(?:achieved|met)|achieved the full target/i.test(text))
    return { ok: false as const, reason: 'narrative_overstates_achievement' };
  return { ok: true as const };
}

export function atlasOperationalFacts(snapshot: AtlasBusinessSnapshot): string {
  const metric = (name: string, item: { value: unknown; source: string; reason?: string }) =>
    `${name}: ${item.value === null ? `unknown (${item.reason || 'unavailable'})` : JSON.stringify(item.value)}. Source: ${item.source}.`;
  return [`Snapshot as of ${new Date(snapshot.asOf).toISOString()}.`,
    `Mission: ${snapshot.mission.value ? 'canonical figures above' : `unknown (${snapshot.mission.reason || 'unavailable'})`}. Source: ${snapshot.mission.source}.`,
    metric('Open cases', snapshot.ops.open_cases), metric('SLA breaches', snapshot.ops.sla_breaches),
    metric('Sitting pending acceptance', snapshot.ops.sitting_pending_accepts), metric('Boarding pending acceptance', snapshot.ops.boarding_pending_accepts),
    metric('Completed-job invoice gap', snapshot.finance.invoice_completed_gap), metric('Trainer earnings readiness', snapshot.finance.trainer_earnings),
    `Internal capability scope, only within the configured envelope: ${ATLAS_ANSWER_SCOPE.internalArtifacts.join(', ')}.`,
    'Recommendations and internal drafts are not external actions. Payments, refunds, payouts, provider assignment, outreach and campaigns remain governed. This answer authorizes none of them. Production readiness is false.',
  ].join('\n');
}
