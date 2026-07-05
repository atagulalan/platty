---
id: protocol-handshake
title: "Protocol: Handshake & Version Negotiation"
tags: [protocol, handshake, versioning, tls]
source: source/syncplay/protocols.py:70-168,452-600,793-806
related: ["[[../README]]", "[[wire-format]]", "[[message-reference]]", "[[../server/overview-and-cli]]", "[[../quirks-and-gotchas]]"]
---

# Protocol: Handshake & Version Negotiation

## Connection sequence

1. TCP connects.
2. **Optional TLS negotiation** (see below) — must happen before Hello if used at all.
3. Client sends `Hello`.
4. Server validates (username/room/version present, password if required), computes a possibly
   renamed username, sends its own `Hello` reply (echoing MOTD, features, version fields).
5. Client is now "logged" (`self._logged = True` server-side) — only after this does the server
   accept `Chat`/`Set`/`List`/`State` (enforced by the `requireLogged` decorator,
   `protocols.py:471-477`; anything else beforehand → `not-known-server-error`).

## Hello message

Full field reference: [`message-reference.md#hello`](message-reference.md#hello). This doc
covers the **version fields specifically**, because they encode a deliberate backward-compat
hack that any reimplementation must replicate exactly to interoperate with old peers — or can
safely ignore if only targeting modern (≥1.3.0) peers.

### The permanent 1.2.255 hack

Every client — including the current 1.7.6 — sends:
```json
{"Hello": {"...": "...", "version": "1.2.255", "realversion": "1.7.6", "...": "..."}}
```
`"version"` is **hard-coded literally as `"1.2.255"`** on every connection
(`protocols.py:165`, comment: `# Used so newer clients work on 1.2.X server`). The *actual*
version travels in the separate `"realversion"` field. This exists because ancient (1.2.x)
servers only understand the `version` field and would reject/mishandle an unrecognized version
string — by always claiming to be "1.2.255" (the highest possible 1.2.x version number), a
modern client passes any version-gate an old server might apply, while still being fully
recognized as its true version by any modern server that reads `realversion` in preference.

The server does the mirror-image trick in its own Hello reply:
```json
{"Hello": {"...": "...", "version": "<the client's own claimed version, echoed back>", "realversion": "<server's true version>", "...": "..."}}
```
(`server`-side, `hello["version"] = clientVersion`, comment: `# Used so 1.2.X client works on
newer server`). An old client that only understands `version` believes the server is running
exactly whatever version *it* itself claimed — always compatible by construction. A modern
client reads `realversion` in preference and thus always learns the server's true version.

**Implication for a reimplementation**: if you want interop with the real ecosystem, your
client must send `version: "1.2.255"` + `realversion: "<your true version>"`, and your server
must echo the client's `version` string back verbatim while putting its own true version in
`realversion`. If you only care about talking to modern (≥1.3.0) peers, you can skip the hack
and just send/expect real version strings in both fields — modern peers already prefer
`realversion` when present.

### Version comparison

`meetsMinVersion(version, minVersion)` (`utils.py:405-408`):
```python
tuple(map(int, ver.split("."))) >= tuple(map(int, minVersion.split(".")))
```
Purely numeric dot-separated tuple comparison — **no support for suffixes** like `-beta`/`rc1`
(such a string would raise `ValueError`). There is no explicit "version mismatch, reject
connection" error anywhere; compatibility is instead handled entirely through feature-flag
gating (below), so mismatched versions degrade gracefully rather than failing outright.

### Feature-flag negotiation

Rather than branching on raw version numbers throughout the codebase, both sides compute a
capability dict once at handshake time from these thresholds (`constants.py:143-148`):

| Feature | Min version |
|---|---|
| Controlled/managed rooms | 1.3.0 |
| User readiness | 1.3.0 |
| Shared playlists | 1.4.0 |
| Chat | 1.5.0 |
| Explicit feature-list exchange | 1.5.0 |
| Server can set others' readiness | 1.7.2 |

- Server: `getFeatures()` (`protocols.py:490-500`) computes its per-connection feature dict
  from these thresholds against the client's negotiated version.
- Client: `checkForFeatureSupport()` (`client.py:659-693`) computes analogous version-inferred
  defaults, then **overlays** any explicit `featureList` dict the server actually sent (servers
  ≥1.5.0 send one) — explicit flags from a modern server win over version-inferred guesses,
  letting an operator disable individual features (e.g. chat) independently of version.
- If the server doesn't meet `SHARED_PLAYLIST_MIN_VERSION`, the client shows
  `shared-playlists-not-supported-by-server-error`; if it meets the version but the feature is
  administratively disabled, `shared-playlists-disabled-by-server-error`.
- `RECENT_CLIENT_THRESHOLD = "1.7.5"` (`constants.py:16`) is used only for an upgrade nag in the
  MOTD (`getMotd`, `server.py:104-121`, gated by `constants.WARN_OLD_CLIENTS = True`), not for
  any functional gating.

## TLS handshake (optional, in-band STARTTLS)

Not a separate listener/port — negotiated over the already-open plaintext socket, **before**
Hello, using Twisted's `transport.startTLS()`.

1. Client, if it supports TLS, sends `{"TLS": {"startTLS": "send"}}` as its first message.
2. Server (`handleTLS`, `protocols.py:793-806`): only responds if not yet logged and
   `serverAcceptsTLS`. It re-checks whether cert files changed on disk since load
   (`checkLastEditCertTime`/`updateTLSContextFactory`, up to `TLS_CERT_ROTATION_MAX_RETRIES = 10`
   retries, `constants.py:262` — allows Let's-Encrypt-style rotation without a restart) before
   replying `{"TLS": {"startTLS": "true"}}` and calling `self.transport.startTLS(...)`, or
   replying `{"TLS": {"startTLS": "false"}}` if TLS isn't available/ready.
3. Client `handleTLS` (`protocols.py:376-395`): checks `"true" in answer` — **substring
   containment, not equality** (a deliberate looseness worth preserving for compatibility, or
   tightening for security, in a reimplementation) — and if TLS is available locally, calls
   `transport.startTLS(...)` itself (with a legacy Twisted<17.1.0 shim registering a manual
   OpenSSL handshake-completion callback). On `"false"`, shows
   `startTLS-not-supported-server` and proceeds to send `Hello` in the clear.
4. After a successful upgrade, the client proceeds to send `Hello` as normal, now over the TLS
   session.

**No client certificate validation** exists server-side — the server only presents a cert
(`CertificateOptions` built without `trustRoot`/`caCerts`); it never authenticates the client via
TLS. Client-side, `SyncClientProtocol` implements `IHandshakeListener.handshakeCompleted`
(`protocols.py:98-119`) purely to inspect the *server's* certificate for its own UI display
(subjectAltName, issuer, expiry) and to detect specific failure strings from `connectionLost`:
`"Invalid DNS-ID"` → mark server as TLS-incapable and allow a clear-text retry; `"tlsv1 alert
protocol version"` → mark client itself as TLS-incapable; `"certificate verify failed"` → drop
with `startTLS-server-certificate-invalid`; `"mismatched_id=DNS_ID"` → drop with
`startTLS-server-certificate-invalid-DNS-ID`.

## Password check

Client sends its configured password **as an MD5 hex digest** inside `Hello.password` (the
server's `_checkPassword`, `protocols.py:531-539`, compares directly against
`self._factory.password`, which is itself MD5(configured password) computed once at server
startup — for this equality to ever succeed, the client must pre-hash the password with MD5
before sending). The password is therefore never sent in true plaintext, but MD5 offers no
meaningful protection without TLS wrapping the connection — a passive network observer who
captures the hash can replay it indefinitely since there's no challenge/nonce.

## Persistent-rooms notice

If the server's `features.persistentRooms` is true but the client doesn't declare/support it, a
fixed notice string is prepended to the MOTD (both sides implement this symmetrically,
`protocols.py:153-154` client / `555-558` server).

## Errors during handshake

See the full table in [`message-reference.md#errors`](message-reference.md#errors). The
handshake-relevant ones: `hello-server-error` (missing username/room/version),
`password-required-server-error`, `wrong-password-server-error`.
