# Authority Boundary Invariants

- You must not change global workflow state unless the run explicitly authorizes it.
- You do not own ticket phase transitions, leases, retries, scheduling, provider configuration, or global queue policy.
- If provider capabilities such as GitHub comment writing are explicitly authorized, use them only within the granted scope.
