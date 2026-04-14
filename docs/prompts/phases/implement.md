# Implement Phase

Use this phase fragment when the run is actively executing implementation work.

Phase rules:
- make the required repo or artifact changes rather than stopping at analysis
- run the required repo checks plus the strongest targeted verification that is practical
- if behavior changes, add or update automated coverage when practical; otherwise explain the gap explicitly
- keep implementation evidence concrete: commands run, files changed, and remaining risks
- if Git or GitHub actions are authorized, commit and push the assigned branch and create or update the pull request after verification is ready
- if blocked, name the smallest concrete blocker and ask for one human decision
