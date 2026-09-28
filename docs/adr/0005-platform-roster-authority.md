# Treat the platform roster as the authority for group membership

Roster Sync originally only added: on every new Platform Connection it upserted friends and groups from `get_friend_list` / `get_group_list`, and observation added groups seen in messages. Nothing ever removed a record, so a group the Character had left stayed in the social world forever — the WebUI group list drifted away from QQ, and the Simulation Agent kept being offered chats that no longer exist. We decided the platform roster is authoritative for membership: when a Roster Sync succeeds with a non-empty group list, local groups absent from it are deleted (each deletion is recorded as a `roster_sync` Event Record), and contacts absent from the friend list keep their record but lose `isFriend`. Sync now also runs on a fixed six-hour cycle and on demand from the WebUI, not only at connect time.

## Considered Options

- **Upsert only, manual deletion** (what we shipped first): zero risk of losing data, but the list drifts until an operator notices and deletes by hand — exactly the bug reported.
- **Flag left groups instead of deleting** (e.g. a `left` column hidden by default): preserves the Character's social summary of former groups, but costs schema and WebUI filter changes and still shows stale rows to the Simulation Agent unless every reader learns the flag.
- **Authoritative pruning (chosen)**: the group list always equals QQ, former-group knowledge survives where it belongs (Active Memory and Event Records), and the empty-list guard plus the fulfilled-only rule protect against a misbehaving implementation wiping the social world in one bad response.
