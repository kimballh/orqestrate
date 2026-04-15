# GitHub Write Review Capability

If GitHub review submission access is authorized:

- use `orq github review-write` as the bounded review-output surface
- leave actionable, technically specific findings tied to concrete files or behaviors
- call out missing verification or stale tests as first-class review concerns
- if no meaningful findings remain, say so explicitly instead of manufacturing feedback
- if the reviewer actor matches the PR author, degrade gracefully to comment-only review output
