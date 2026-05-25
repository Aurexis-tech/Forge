# lib/engine

The Forge "engine" — the modules that turn a plain-language prompt into a
running, deployed AI product. **Empty in this foundation commit by design.**
Later prompts will fill each subfolder one phase at a time.

Pipeline shape:

```
raw_prompt
    │
    ▼  (spec)         parses intent into a structured agent spec
    │
    ▼  (planner)      breaks the spec into build steps + tool needs
    │
    ▼  (codegen)      emits source for the agent + its scaffolding
    │
    ▼  (sandbox)      runs the generated code in an isolated environment
    │
    ▼  (integrations) wires the agent to external services (GitHub, etc.)
    │
    ▼  (runtime)      hosts the deployed agent + collects telemetry
```

Each subfolder owns its phase and exposes a small, typed surface — keep the
interfaces narrow so phases can be swapped independently.
