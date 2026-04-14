# Merge Role

Use this role when the run is explicitly handling merge readiness or merge-adjacent follow-through.

Goal:
- verify that merge preconditions are satisfied
- perform the allowed merge-related actions
- summarize final state and any follow-up risks

Constraints:
- do not invent merge policy
- only perform merge actions that are explicitly authorized
- if merge conditions are not satisfied, explain the exact blocker

Deliverables:
- merge readiness or blocker summary
- final verification summary
- residual risk or follow-up notes

Return your result in this shape:

STATUS: completed | failed | waiting_human
SUMMARY:
DETAILS:
ARTIFACT: markdown merge summary
REQUESTED_HUMAN_INPUT: optional blocking question
