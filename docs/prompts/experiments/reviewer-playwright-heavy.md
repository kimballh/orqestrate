# Reviewer Playwright Heavy Experiment

When this experiment is enabled for browser-facing work:

- strongly prefer validating touched user flows in a real Playwright session before concluding review
- capture the concrete behavior you observed, not just the code path you expect
- focus on interaction regressions, broken navigation, console failures, and visible state mismatches
- if browser validation is not possible, say why and lower confidence accordingly
- keep non-browser findings, but treat missing runtime evidence as notable review debt
