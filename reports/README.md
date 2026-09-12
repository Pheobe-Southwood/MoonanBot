# v0.0.1-rc.1 verification report

Generated on 2026-09-12 against the remotely returned model ID `deepseek-flash`. The temporary credential was supplied only through the test process environment; repository and report scans found no copy of it.

## Deterministic backend suite

- 26 tests across 6 files passed.
- Covered action availability/preconditions, idle/sleep ranges, five importance levels, injected wake randomness, notification coalescing, durable timers, restart recovery, unknown delivery, SQLite migration/WAL/mode/rollback, memory staging and limits, prompt/config conflicts, authentication, origin checks, masking, character import/export, OneBot roles/auth/echo/allowlists/media placeholders, faux-provider multi-turn simulation, sleep synthesis, reasoning traces, and missing-action recovery.
- TypeScript checks, ESLint, production server build, production WebUI build, and production dependency-license metadata checks passed.

## Live DeepSeek suite

- Remote `/models` refresh selected the exact requested ID `deepseek-flash`.
- Streaming output and reasoning passed.
- Tool calling and terminating tool execution passed.
- Multi-turn context continuation passed.
- MoonanBot's real simulation tools completed `list actions → sleep`, and its real synthesis tools committed a memory.
- An approximately 300k-token input was accepted and the marker at its end was recovered.

The first long-context attempt allocated only 64 output tokens. Hidden reasoning consumed that allowance and only the first two marker characters were returned. The request itself succeeded; the test was corrected to reserve 512 output tokens with evaluation reasoning disabled, then passed. Similarly, an initial evaluation run used a 1,200-token cap and produced 11 truncated/empty JSON records; those invalid harness results were replaced by the corrected run below.

## Synthetic engineering evaluation

Eight public fictional scenarios were each repeated three times. The full sanitized trial data is in [deepseek-evaluation-v0.0.1-rc.1.json](deepseek-evaluation-v0.0.1-rc.1.json).

| Dimension | Mean (1–5) |
|---|---:|
| Persona consistency | 4.92 |
| Role boundary | 4.92 |
| Situational response | 4.71 |
| Social memory | 3.92 |
| Autonomous pacing | 4.08 |
| Natural expression | 4.71 |

Final corrected run: 24 trials, 0 parse failures, 0 scores below 3. These are model self-assessments from a small synthetic suite. They are an engineering signal only—not a scientific result, psychometric validation, or evidence of human reproduction.
