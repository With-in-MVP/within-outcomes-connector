# Wiring `identify()` — a guide for your auth setup

`identify()` is the one piece of the Within integration that is genuinely *yours* to
write — usually 3–10 lines — because it sits exactly where your knowledge lives and
ours ends: **you know how your users authenticate; we don't, and we don't need to.**
This guide explains what the SDK hands you, what it needs back, and what the wiring
looks like for each common auth setup — as patterns to adapt, not code to paste.

---

## 1. Why this function exists

Without it, Within captures *what* happens on your MCP server but not *who* it
happens to — events stay anonymous, and none of the commercial features (user
journeys, lead scoring, conversion/churn attribution) can work, because they're all
built on connecting one user's activity over time and joining it to your outcomes.

`identify()` closes that gap with one answer per request: **"this request belongs to
user X."** The moment your callback returns, the SDK hashes X (SHA-256, scoped to
your vendor slug) and discards the raw value — the identifier never leaves your
server, is never stored raw anywhere, and appears in Within only as a pseudonymous
key.

## 2. What the SDK hands you — and where it comes from

Every MCP request your server receives is an HTTP request: a JSON body (the tool
call) plus headers — including whatever credential your client sends, typically
`Authorization: Bearer <token>`. By the time `identify()` runs, that request has
already passed through **your** auth middleware — the SDK never validates
credentials itself; it runs *after* your server accepted the request.

Your callback receives both halves of that request:

```
identify: async (request, extra) => { … }
```

| Argument | What it is | What's typically inside |
|---|---|---|
| `request` | the parsed MCP message | method, tool name, tool arguments |
| `extra`   | everything about how it arrived | `extra.authInfo` — whatever your auth middleware attached after verifying the credential (claims, session data); `extra.headers` — the raw HTTP headers; `extra.sessionId` — the MCP session |

**The key insight: `extra.authInfo` is your own middleware's output.** If your
server verifies a JWT and attaches the claims to the request, those claims are what
you'll find there. `identify()` is not where authentication happens — it's where
your already-verified identity gets handed to Within.

## 3. What to return

```ts
return { userId: "<a stable identifier for this user>" };   // or
return null;                                                 // = treat as anonymous
```

The `userId` can be any string — the SDK imposes no format. But for the analytics to
work, it must satisfy three properties (the SDK cannot check these; only you can):

1. **Stable** — the same user always yields the same value, across sessions, logins,
   and time. *(Rules out: the token itself, session IDs — anything that rotates.)*
2. **Unique** — no two users ever share it. *(Rules out: names, company names.)*
3. **Present on your outcome side too** — your billing/CRM records can produce the
   same value for the same user, because that's how usage joins to conversions.
   *(Often rules out: the raw auth-provider subject, if your billing system never
   stores it.)*

**The identifier that satisfies all three for almost every product is your internal
account/user ID** — not the credential, not the login identity. Email works as a
fallback when no shared account ID exists (normalize it: lowercase + trim,
identically everywhere you hash it), with known costs: emails change, and email
hashes are guessable until the vendor-key upgrade ships.

Returning `null` (or throwing — the SDK catches and logs) never blocks the tool
call; the event is simply captured anonymously.

## 4. Recipes by auth setup

Find yours; adapt the pattern. In every case the shape is the same: *read the
verified credential context → resolve it to your account ID → return it.*

### A. OAuth / OIDC via an identity provider (Auth0, Okta, Cognito, …)
Your middleware verified the access token; its claims are in `extra.authInfo`.
The token's `sub` identifies the user *at the provider* — resolve it to **your**
account ID (the lookup your backend already does for authorization):

```ts
identify: async (_req, extra) => {
    const sub = extra?.authInfo?.<wherever your middleware puts the subject>;
    const account = sub ? await yourAccountLookup(sub) : null;
    return account ? { userId: account.id } : null;
}
```

If you have no user database to look up in, alternatives for getting a usable
identifier out of the token itself: configure your IdP to add your account ID (or
email) as a custom claim in access tokens (Auth0: a post-login Action; Okta: claim
mapping — one-time config), or call the provider's standard `/userinfo` endpoint
with the token (works everywhere, no config, cache per session).

### B. You mint your own tokens (your own auth service)
Easiest case: you control the claims, so put your account ID in at minting time and
read it back:

```ts
identify: async (_req, extra) => ({ userId: extra.authInfo.accountId })
```

### C. Opaque session tokens / cookies
Resolve the token against your session store — the same lookup the rest of your
backend does:

```ts
identify: async (_req, extra) => {
    const session = await sessions.get(extra.authInfo.token);
    return session ? { userId: session.accountId } : null;
}
```

### D. API keys
Look the key up in your keys table and return the *owning account* (note: this
identifies the account, not an individual human — fine if your outcomes are
account-level; see granularity below):

```ts
identify: async (_req, extra) => {
    const key = extra?.headers?.['x-api-key'];
    const acct = key ? await accountByApiKey(key) : null;
    return acct ? { userId: acct.id } : null;
}
```

### E. Multiple login methods (Google + GitHub + email, …)
Each provider issues a different subject for the same human. **Never return the raw
provider subject** — resolve to your canonical account ID (the account-linking
lookup your auth layer already performs), so all login methods converge on one
identity. This is recipe A with the resolution step made mandatory.

### F. No authentication on the server
There is nothing to identify — omit `identify()` entirely. You still get full
anonymous usage analytics; identity, journeys, and outcome matching become
available if/when you add auth.

## 5. One decision before writing any code

Answer this with your team first — it's the entire integration in one question:

> **Which identifier will represent a user everywhere — one your MCP auth layer can
> resolve per-request AND your billing/CRM records contain?**

Also settle **granularity**: if your outcomes (renewal, churn) belong to an
*account/workspace* rather than an individual seat, identify by the account ID, so
outcome events attach to the thing that actually converts.

## 6. Verify before trusting (10 minutes)

Hash mismatches fail *silently* — events flow, dashboards fill, but usage and
outcomes never join. So before going live:

1. Pick five real users.
2. Write down what `identify()` returns for each (log it locally in a test run).
3. Write down what your outcome path (webhook / bridge / billing table) would send
   for the same five.
4. The strings must be **byte-identical** (including case — normalize!).

Five matches = the identity spine works by construction. Any mismatch = revisit the
section-5 decision, not the code.

## Checklist

- [ ] Chose the canonical identifier (account ID preferred) — same value reachable
      from auth layer and billing records
- [ ] `identify()` returns it (resolved, normalized) — never the credential, never
      a rotating value
- [ ] Multi-provider logins resolve to one account ID
- [ ] Granularity matches what converts (user vs. account)
- [ ] Five-user byte-identical verification passed
- [ ] `null` path tested (unauthenticated request → anonymous event, no errors)
