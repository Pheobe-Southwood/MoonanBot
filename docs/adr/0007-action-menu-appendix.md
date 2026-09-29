# Return the available-action menu with every message instead of a discovery tool

The simulation agent originally exposed two public tools: `list_available_actions` to discover what the phone state permits, and `perform_action` to act. Discovery cost a full LLM round trip, its answer could be stale by the next call, and models sometimes skipped it or acted on an outdated menu; error results told the model what failed but not what it could do instead. We removed `list_available_actions` and made the system the only narrator of the action surface: every world-event user message and every `perform_action` result — including errors, which now carry the reason followed by the menu — ends with the currently available actions, rendered from the same `listAvailableActions` phone-state machine that validates execution. The fixed per-message menu costs tokens, but navigation can never be lost, stale, or forgotten, and validation and narration cannot drift apart because they read one function.

## Considered Options

- **Keep the discovery tool**: cheapest in tokens when unused, but discovery is an extra round trip, the menu can go stale between calls, and errors leave the model guessing.
- **One native tool per action**: the model's tool list would reflect availability natively, but it contradicts the Action-is-not-a-tool-call vocabulary (CONTEXT.md), needs per-tool terminate marking for the terminating-action invariant, and still cannot express Phone State preconditions without runtime errors.
- **Append the menu to every message and result (chosen)**: always-current navigation with zero extra round trips; the token overhead is bounded by the small per-state menu, and a single state machine drives both the appendix and execution validation.
