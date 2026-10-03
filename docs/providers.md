# Providers and OAuth

MoonanBot registers the complete provider catalog exported by `@earendil-works/pi-ai@0.85.1`, including API-key, OAuth, cloud-IAM, and subscription-token authentication types. Provider availability still depends on the provider's own account, region, SDK, and upstream service.

In Connections you can:

1. Store an API key.
2. Start an OAuth login session and answer device-code or verification prompts.
3. refresh the provider's model list.
4. Add and edit multiple OpenAI-compatible endpoints with their own Base URL and key.

DeepSeek model refresh keeps pi-ai's static catalog as the baseline: remote ids from an explicit `/models` request join it as an overlay, and the stored provider ID remains `deepseek`, preserving its protocol adapter.

Custom endpoints own a persisted **Known Model List** (see [ADR-0010](adr/0010-custom-provider-model-persistence.md)). Refreshing one is a server-side pull of `GET {baseUrl}/models` that works with or without an API key — keyless local endpoints (LM Studio, vLLM, …) are first-class — and every successful non-empty result replaces the stored list, so it survives restarts and version updates. An empty or failed remote answer never clears the stored list; the reason is recorded as refresh state and shown on the provider card together with the last sync time. All custom providers are re-synced once in the background at boot. Editing an endpoint (rename, new Base URL, rotated key) preserves the stored list and keeps the existing key when the key field is left blank; only an explicit non-empty model array through the API replaces the list. Custom OpenAI-compatible models default to 128k context and 8k output unless configured through the API.

The Simulation and Synthesis Agents select provider, model, and thinking level independently. Either can inherit the global default.

Provider API keys and OAuth tokens are intentionally stored as plaintext inside the mode-`0600` SQLite database. The Web API masks returned secrets, and request logging never includes bodies. Read [security.md](security.md) before backing up or exposing the service.
