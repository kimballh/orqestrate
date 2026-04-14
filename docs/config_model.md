# Config Model

This file defines the configuration format for the harness.

## 1. Recommendation

Use `config.toml`.

That is the right default for an open-source local-first tool because it is:

- readable
- diffable
- easy to hand-edit
- good for named profiles and provider instances

Secrets should not be stored directly in the file.
Use environment-variable references in config instead.

## 2. Config goals

The config should support:

- many named provider instances
- different deployment profiles
- local-only mode
- mixed mode, like `linear + local_files`
- future providers without changing the top-level schema

## 3. Top-level structure

Recommended top-level sections:

- `version`
- `active_profile`
- `[paths]`
- `[policy]`
- `[prompts]`
- `[prompt_packs.<name>]`
- `[providers.<name>]`
- `[profiles.<name>]`

## 4. Example

See [config.example.toml](./config.example.toml).

## 5. Recommended schema

```toml
version = 1
active_profile = "local"

[paths]
state_dir = ".harness/state"
data_dir = ".harness/data"
log_dir = ".harness/logs"

[policy]
max_concurrent_runs = 4
max_runs_per_provider = 2
allow_mixed_providers = true
default_phase_timeout_sec = 5400

[prompts]
root = "./prompts"
active_pack = "default"

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
plan = "roles/plan.md"
implement = "roles/implement.md"
review = "roles/review.md"
merge = "roles/merge.md"

[providers.linear_main]
kind = "planning.linear"
token_env = "LINEAR_API_KEY"
team = "ENG"
webhook_signing_secret_env = "LINEAR_WEBHOOK_SECRET"

[providers.notion_main]
kind = "context.notion"
token_env = "NOTION_TOKEN"
artifacts_database_id = "xxxxxxxx"
runs_database_id = "yyyyyyyy"

[providers.local_planning]
kind = "planning.local_files"
root = ".harness/local/planning"

[providers.local_context]
kind = "context.local_files"
root = ".harness/local/context"

[profiles.saas]
planning = "linear_main"
context = "notion_main"
prompt_pack = "default"

[profiles.local]
planning = "local_planning"
context = "local_context"
prompt_pack = "default"

[profiles.hybrid]
planning = "linear_main"
context = "local_context"
prompt_pack = "default"
```

## 6. Provider instance rules

Each provider instance must have:

- a unique name
- a `kind`
- only fields relevant to that kind

Examples:

- `planning.linear`
- `planning.local_files`
- `context.notion`
- `context.local_files`

Future examples:

- `planning.asana`
- `context.google_drive`

## 7. Profile rules

Profiles should choose active provider instances by name.

```toml
[profiles.default]
planning = "linear_main"
context = "notion_main"
prompt_pack = "default"
```

This lets the same installation support multiple deployment modes:

- production SaaS profile
- local development profile
- self-hosted file-based profile
- prompt-pack variations for the same backend combination

## 8. Environment variable references

Keep credentials in environment variables and reference them by name.

Good:

```toml
[providers.linear_main]
kind = "planning.linear"
token_env = "LINEAR_API_KEY"
```

Avoid:

```toml
[providers.linear_main]
kind = "planning.linear"
token = "actual-secret"
```

## 9. Validation model

Config loading should happen in three phases:

1. parse TOML
2. validate shape against a schema
3. instantiate selected providers and run provider-specific validation

Failures should be explicit and friendly:

- unknown provider `kind`
- missing required field
- missing environment variable
- profile references unknown provider instance
- provider kind does not match profile role

## 10. Role validation

Profiles should enforce role compatibility.

Examples:

- `planning = "linear_main"` is valid if `linear_main.kind = "planning.linear"`
- `planning = "notion_main"` is invalid because Notion is a context backend

This matters because the config is open to extension and we do not want ambiguous provider wiring.

## 11. Local-first default

The project should be able to ship with a fully working default local profile:

```toml
active_profile = "local"

[providers.local_planning]
kind = "planning.local_files"
root = ".harness/local/planning"

[providers.local_context]
kind = "context.local_files"
root = ".harness/local/context"

[profiles.local]
planning = "local_planning"
context = "local_context"
```

That gives open-source users a zero-credential first-run path.

## 12. Suggested future extensibility

Leave room for optional provider-specific nested sections:

```toml
[providers.linear_main]
kind = "planning.linear"
token_env = "LINEAR_API_KEY"
team = "ENG"

[providers.linear_main.mapping]
ready_status = "Ready"
blocked_status = "Blocked"
done_status = "Done"
```

And:

```toml
[providers.local_context]
kind = "context.local_files"
root = ".harness/local/context"

[providers.local_context.templates]
artifact_template = "default_artifact"
run_template = "default_run"
```

This keeps the top-level config stable while allowing provider-specific tuning.

Leave room for prompt-pack customization too:

```toml
[prompts]
root = "./prompts"
active_pack = "default"

[prompt_packs.default.overlays]
organization = ["overlays/org/reviewer-qa.md"]
project = ["overlays/project/reviewer-webapp.md"]

[prompt_packs.default.experiments]
reviewer_v2 = "experiments/reviewer-v2.md"
```

This keeps prompt customization config-driven instead of hardcoded.

## 13. Recommendation

Use:

- `config.toml`
- named provider instances
- profile-based provider selection
- prompt-pack selection through config
- env-var references for secrets
- a built-in local profile using `local_files` for both planning and context

That gives us a clean open-source story and a practical path for future providers.
