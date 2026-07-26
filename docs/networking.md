# Networking: reaching the microVM, and portless URLs

## What already works (measured 2026-07-25)

**Outbound**: transparent. libkrun's TSI backend hijacks the guest's `connect()` and proxies it
through the host — no tap device, no root, no configuration. The agent reaches the model API
and git remotes with nothing set up.

**Inbound: also already works.** This was the surprise. From `libkrun.h:593`:

> Passing NULL (or not calling this function) as `port_map` has a different meaning than
> passing an empty array. The first one will instruct libkrun to attempt to **expose all
> listening ports in the guest to the host**, while the second means that no port from the
> guest will be exposed to host.

`yeet-vm` never calls `krun_set_port_map`, so every port the guest listens on is already
reachable from the host. Verified end to end: a `Bun.serve({port: 8099})` inside the guest
answered `curl http://127.0.0.1:8099/` from the host within one second of boot.

**The constraint to design around** (`libkrun.h:598`): exposed ports keep the *same number* on
both sides. For a map `8080:80` the guest must also use 8080. With no map at all, host port ==
guest port, always. So two VMs both serving on 3000 collide on the host — **the controller must
assign each VM a distinct port and tell the guest which one to use.**

Note port mapping is unavailable if passt/gvproxy networking is ever adopted
(`krun_add_net_unixstream`, `libkrun.h:448`); that would be a trade of this simplicity for
network isolation.

## Design: `https://<agent>.localhost`

Four pieces, only the last of which is real work.

**1 · Port allocation (controller).** Each agent gets a stable port from a private range, e.g.
`41000 + (hash(name) % 1000)`, recorded in `agent.json` and reused across boots so a URL stays
valid. Collisions are resolved by probing upward at allocation time.

**2 · Telling the guest.** Injected as `PORT` via `--env`, which is safe: env values round-trip
byte-exact (unlike argv — see the corruption note in `yeet-vm.c`). Honouring `$PORT` is
near-universal convention, and the app the agent writes is told to respect it in the prompt.
Nothing else changes; the guest binds `0.0.0.0:$PORT` and libkrun exposes it.

**3 · Name resolution.** `*.localhost` already resolves to `127.0.0.1` in Chrome, Safari and
Firefox with no `/etc/hosts` entry — the browsers special-case it. Command-line clients are
less consistent on macOS, so `curl` may need `--resolve`; that's a documentation footnote, not
a blocker, because the point of this feature is opening a browser.

**4 · The router (the actual work).** One long-lived host process — `yeet serve` — listening on
`:443`, routing purely on the `Host:` header:

```
<agent>.localhost  ->  127.0.0.1:<that agent's port>
```

It reads `~/.yeet/agents/*/agent.json` to build the table and re-reads on change, so it needs
no coordination with running agents. Unknown host → 404 naming the known agents. Agent known but
its port not listening → 502 with "the VM isn't running; try `yeet run <agent>`".

TLS wants a certificate valid for `*.localhost`. `mkcert` installs a local CA and issues one in
a single command; without it the same router serves plain HTTP on `:8080` and the URL becomes
`http://<agent>.localhost:8080`. Binding `:443` needs either root or a one-time
`setcap`-equivalent, which on macOS means running the router via `launchd` — a reason to prefer
`:8443` by default and make `:443` opt-in.

## CLI shape

```bash
yeet run <agent>          # boot the agent's VM with its app serving, print the URL
yeet serve                # start the router (idempotent; auto-started by `yeet run`)
```

`yeet run` is deliberately distinct from `yeet "<task>"`: it starts no agent loop and spends no
tokens. It boots the workspace as it currently stands, which is what you want for looking at
the result of a finished agent.

## Why not vsock

`krun_add_vsock_port` (`libkrun.h:915`) pairs a guest vsock port with a host UNIX socket, and
would work — but it requires the guest app to speak vsock rather than TCP, which no normal web
framework does. TSI's automatic port exposure gets the same result with an unmodified app. Vsock
is the right answer for a *control* channel (live steering, streaming) rather than for serving
user traffic.

## Security note

Automatic exposure of every listening guest port is convenient and slightly alarming: anything
the agent starts becomes reachable on the host's loopback. Combined with unrestricted TSI
egress, a compromised or careless agent has a broad surface. When egress policy is tackled
(`krun_disable_implicit_vsock` plus a filtering proxy), inbound should be narrowed at the same
time by passing an explicit `krun_set_port_map` containing only the allocated port.
