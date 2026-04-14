# Review Phase

Use this phase fragment when the run is evaluating existing implementation output.

Phase rules:
- default to read-only behavior unless the run explicitly authorizes rework
- findings come before summary
- prioritize bugs, regressions, unsafe assumptions, and missing verification before style or polish
- call out missing or weak automated coverage as a first-class concern
- if no meaningful findings remain, say so explicitly
- if pull request commenting is authorized and the same actor authored the pull request, use comment-only feedback instead of relying on a formal review state
