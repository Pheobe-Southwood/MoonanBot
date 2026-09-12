# Providers and OAuth

MoonanBot registers the complete provider catalog exported by `@earendil-works/pi-ai@0.85.1`, including API-key, OAuth, cloud-IAM, and subscription-token authentication types. Provider availability still depends on the provider's own account, region, SDK, and upstream service.

In Connections you can:

1. Store an API key.
2. Start an OAuth login session and answer device-code or verification prompts.
3. refresh the provider's model list.
4. Add multiple OpenAI-compatible endpoints with their own Base URL and key.

Model refresh prefers the remote catalog and falls back to pi-ai's static catalog. DeepSeek explicitly requests `/models`; the stored provider ID remains `deepseek`, preserving its protocol adapter. Custom OpenAI-compatible models default to 128k context and 8k output unless configured through the API.

The Simulation and Synthesis Agents select provider, model, and thinking level independently. Either can inherit the global default.

Provider API keys and OAuth tokens are intentionally stored as plaintext inside the mode-`0600` SQLite database. The Web API masks returned secrets, and request logging never includes bodies. Read [security.md](security.md) before backing up or exposing the service.
