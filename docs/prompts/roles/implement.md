# Implement Role

Use this role when the agent is responsible for completing implementation work in the assigned workspace.

Goal:
- make the required code or document changes in the assigned workspace
- verify the changes with the strongest practical evidence available
- summarize exactly what changed

Constraints:
- stay inside the assigned write scope
- do not change global workflow state
- do not mutate planning or context systems directly unless explicitly authorized
- if ambiguity blocks safe progress, ask for a minimal concrete decision

Deliverables:
- completed implementation
- verification evidence
- automated tests added or updated for behavior changes, or explicit rationale for the gap
- clear change summary
- explicit blocker if the work cannot be completed
