// Pure control-wiring classification for the Release UI closure gate.
//
// This lives apart from scripts/release-ui-closure.mjs so the decision that turns raw browser
// evidence into a pass/fail verdict is directly unit-testable, instead of only being reachable
// through a Playwright run against an isolated preview.
//
// The gate's question is "did this control demonstrably do something", never "does this control
// exist". Every result below that counts as wiring is backed by an observed browser effect:
// a navigation, an API request, a dialog, a committed DOM mutation, a blocked mutating request,
// a constraint-validation event, or a committed DOM mutation after the control's own state was
// displaced. Absence of evidence is always a failure.
//
// There is deliberately NO identity/authorisation exemption here. An unmet identity precondition
// on a route is recorded as route context in the report, never as a verdict: if it were a verdict
// it would exempt every no-effect control on that route, including a genuinely unwired one that
// happens to sit next to a background 401. Controls are judged only on their own evidence.

export const CONTROL_RESULT = {
  wired: "wired",
  wiredMutationBlocked: "wired_mutation_blocked",
  wiredValidationBlocked: "wired_validation_blocked",
  wiredIdempotent: "wired_idempotent",
  clickError: "click_error",
  noObservableEffect: "no_observable_effect",
  indexDrift: "index_drift",
  routeUnavailable: "route_unavailable",
};

// A finding is a gate failure when the probe could not obtain wiring evidence, could not trust
// that it probed the control it meant to probe, or could not get a serviceable PawSpace document
// to probe at all.
const FAILURE_RESULTS = new Set([
  CONTROL_RESULT.clickError,
  CONTROL_RESULT.noObservableEffect,
  CONTROL_RESULT.indexDrift,
  CONTROL_RESULT.routeUnavailable,
]);

export const isControlFailure = (result) => FAILURE_RESULTS.has(result);

const hasDirectEffect = (evidence) => Boolean(
  evidence.navigationSeen || evidence.mutationAttempt || evidence.requestSeen || evidence.dialogSeen || evidence.changed,
);

/**
 * Turn one control probe's observed evidence into a gate verdict.
 *
 * @param {object} evidence
 * @param {boolean} [evidence.destructive]      Control text matched the destructive-intent vocabulary.
 * @param {string|null} [evidence.mutationAttempt]   Mutating request seen and aborted before execution.
 * @param {string|null} [evidence.requestSeen]       API request observed.
 * @param {string|null} [evidence.dialogSeen]        Native dialog observed.
 * @param {string|null} [evidence.navigationSeen]    URL changed after the click.
 * @param {boolean} [evidence.changed]               Body text changed or the MutationObserver committed records.
 * @param {object|null} [evidence.validationBlocked] Constraint validation fired for the control's own form.
 * @param {object|null} [evidence.displacement]      Second-pass probe after displacing the control's state.
 * @param {string|null} [evidence.error]             Click threw.
 * @param {boolean} [evidence.indexDrift]           Probe could not confirm it resolved the intended element.
 * @param {boolean} [evidence.routeUnavailable]     No serviceable PawSpace document was reachable.
 */
export function classifyControl(evidence = {}) {
  if (evidence.routeUnavailable) return CONTROL_RESULT.routeUnavailable;
  if (evidence.indexDrift) return CONTROL_RESULT.indexDrift;

  // A destructive control that reached a mutating request is wired, and the request was aborted
  // before it executed. This check stays ahead of the generic evidence check so the report keeps
  // naming which controls were only proven safe-by-abort.
  if (evidence.destructive && evidence.mutationAttempt) return CONTROL_RESULT.wiredMutationBlocked;

  if (hasDirectEffect(evidence)) return CONTROL_RESULT.wired;

  // A submit control whose form is pristine cannot navigate, request or mutate: the browser's
  // constraint validation stops submission first. The `invalid` event is positive proof the click
  // reached its form's submission machinery, which an unwired button never does.
  if (evidence.validationBlocked?.form) return CONTROL_RESULT.wiredValidationBlocked;

  // An already-active filter/tab writes the state it already holds, React bails out, and nothing
  // is committed. Moving that state away first - by clicking a sibling, or by setting a sibling
  // field - means the control must then commit a change. Evidence, not exemption.
  if (evidence.displacement?.attempted && evidence.displacement.changed) return CONTROL_RESULT.wiredIdempotent;

  if (evidence.error) return CONTROL_RESULT.clickError;
  return CONTROL_RESULT.noObservableEffect;
}

export function summariseControlResults(controls) {
  const counts = Object.create(null);
  for (const control of controls) counts[control.result] = (counts[control.result] || 0) + 1;
  return {
    probed: controls.length,
    failures: controls.filter((control) => isControlFailure(control.result)).length,
    byResult: counts,
  };
}
