# GitHub Read PR Capability

If pull-request read access is authorized:

- use `orq github pr-read` as the read surface for the linked PR
- inspect the linked pull request metadata, diff, comments, and review context before acting
- ground implementation or review decisions in the current PR state instead of assumptions
- stay scoped to the linked pull request for this run
