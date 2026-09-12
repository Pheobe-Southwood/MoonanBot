# Engineering evaluation

The v0.0.1 release candidate uses two complementary checks:

- deterministic Vitest coverage for state transitions, persistence, security boundaries, OneBot protocol behavior, faux-provider agent loops, and context thresholds;
- a live DeepSeek smoke/long-context suite plus 24 synthetic role-play trials (eight scenarios, three repetitions).

The synthetic persona is public and fictional. Scenarios cover interruption, invitation, conflict, apology, group dynamics, worry, remembered commitments, and unstructured idle time. Each response is scored from 1–5 on persona consistency, role boundary, situational response, social memory, autonomous pacing, and natural expression. Failures and the actual model ID are retained in a sanitized report; credentials are never written to reports or SQLite.

This is an engineering sanity check, not a scientific study, psychometric instrument, or claim that MoonanBot reproduces a human being. A model judging its own family of outputs is biased, scenario coverage is small, and results are sensitive to provider changes.
