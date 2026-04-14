# Reviewer QA Overlay

Apply these extra review heuristics when this overlay is selected:

- ask whether the reported behavior was actually reproduced or just reasoned about
- look for missing negative-path, empty-state, and error-state validation
- call out risky assumptions around retries, permissions, timeouts, data freshness, or flaky external systems
- prefer concrete verification guidance over broad advice when you find a problem
- note explicitly when the available evidence is too weak to justify confidence
