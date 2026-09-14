// Explicit acknowledgements for positive service journeys. Rejection tests override this with missing items.
export const fixtureChecklist=action=>action==="start_service"?["pet_identity","safety_review","safe_setup"]:action==="complete"?["service_delivered","pet_welfare","customer_handover","proof_captured"]:[];
