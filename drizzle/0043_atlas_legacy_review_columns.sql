-- Legacy review evidence stays unknown; never backfill authority or hashes.
-- @add-column-if-missing atlas_proposal_reviews|reviewer_role_code|TEXT
-- @add-column-if-missing atlas_proposal_reviews|reviewer_authority_source|TEXT
-- @add-column-if-missing atlas_proposal_reviews|review_auth_assurance_type|TEXT
-- @add-column-if-missing atlas_proposal_reviews|review_auth_session_id|TEXT
-- @add-column-if-missing atlas_proposal_reviews|review_mfa_verified_at|INTEGER
-- @add-column-if-missing atlas_proposal_reviews|review_hash_version|INTEGER
-- @add-column-if-missing atlas_proposal_reviews|review_sequence|INTEGER
-- @add-column-if-missing atlas_proposal_reviews|previous_review_hash|TEXT
-- @add-column-if-missing atlas_proposal_reviews|review_hash|TEXT

-- Verify the deployed shape after the guarded additions.
SELECT reviewer_role_code,reviewer_authority_source,review_auth_assurance_type,review_auth_session_id,review_mfa_verified_at,review_hash_version,review_sequence,previous_review_hash,review_hash FROM atlas_proposal_reviews LIMIT 0;
