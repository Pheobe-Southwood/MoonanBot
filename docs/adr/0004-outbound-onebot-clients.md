# Let MoonanBot dial OneBot instead of only accepting inbound sockets

MoonanBot supported one connection direction: the OneBot implementation had to dial MoonanBot's reverse WebSocket on the host loopback. QQ implementations that run in a container cannot reach the host loopback, so such deployments needed an extra TCP relay in front of MoonanBot. We decided to also support the opposite direction as a first-class mode: `onebot.outbound` lists OneBot endpoints, and MoonanBot dials each one and treats the resulting socket exactly like a reverse socket — same token check, same one-`self_id` rule, same event and API handling. Both directions stay available, with reverse connections enabled by default so existing setups are unaffected.

## Considered Options

- **Relay in front of the loopback port** (what we shipped first as an operator workaround): no code change, but it adds a process, a systemd unit, and a host address that must be reachable from the container — every deployment would have to reinvent it.
- **Bind the reverse endpoint to a routable interface**: removes the relay, but exposes an authenticated-but-unencrypted bot endpoint on the LAN, which is a worse default than dialing out.
- **Outbound clients (chosen)**: the container needs no inbound route to the host, the operator configures it in the same Connections UI as the token and allowlists, and the setting is data rather than infrastructure.
