If GitHub pull-request merge access is authorized:

- use `orq github pr-merge --dry-run` to evaluate the linked pull request against merge policy before attempting a merge
- use `orq github pr-merge` for the actual merge so policy, scope, and head-commit safety stay bounded to the linked pull request
- do not use raw `gh pr merge` or ambient GitHub tooling directly
- if the dry run reports a blocker or approval requirement, surface that result explicitly instead of guessing or forcing a merge
