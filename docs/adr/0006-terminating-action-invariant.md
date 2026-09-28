# Require every simulation run to end in a Terminating Action

A simulation run schedules the Character's next wake only through a Terminating Action (`idle` or `sleep`). The first correction mechanism counted `perform_action` calls and only intervened when the count was zero, so a run that acted — sent messages, browsed the phone — and then simply stopped left the Character `awake` with no timer: silently stalled until somebody wrote to it. We decided the invariant is about the ending state, not the call count: after the agent loop returns, a Character still `awake` has no scheduled continuation and receives a correction prompt (worded differently for "no action at all" and "acted but scheduled nothing"), up to `simulation.missingActionRetries` times; if it still does not terminate, the system forces a thirty-minute idle and marks the runtime degraded.

## Considered Options

- **Count `perform_action` calls only** (what we shipped first): cheap, but blind to the common case where the run performs non-terminating actions and then ends.
- **Inspect the last assistant message** (correct only when the loop ends on plain text): closest to the original wording of the design intent, yet misses runs whose final message is a non-terminating tool call.
- **Post-run state check (chosen)**: `runtime.mode === "awake"` after the loop is exactly "no Terminating Action happened", covers both failure shapes, cannot be fooled by failed or miscounted tool calls, and doubles as the loop-exit condition for the correction retries; `paused` naturally suppresses correction because an operator pause is not a stalled run.
