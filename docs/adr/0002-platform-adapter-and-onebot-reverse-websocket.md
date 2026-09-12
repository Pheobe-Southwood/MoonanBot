# Isolate platforms behind an adapter

The core depends on a `ChatPlatformAdapter`, while v0.0.1 supplies a OneBot v11 reverse-WebSocket adapter on the application server. This keeps the first release small without coupling character behavior to QQ-specific identifiers or non-standard history APIs.
