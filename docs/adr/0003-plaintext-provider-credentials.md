# Store provider credentials in plaintext SQLite

The operator explicitly chose WebUI-managed plaintext API keys and OAuth tokens over encryption at rest. MoonanBot therefore relies on a dedicated service account, mode-0600 database permissions, masked APIs, redacted logs, and explicit backup warnings; disk compromise remains an accepted risk.
