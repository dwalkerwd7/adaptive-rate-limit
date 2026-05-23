# Admin Dashboard — Example App

A live admin UI for `@dtl/adaptive-rate-limit`. Shows all active rate-limit identifiers, their current window counts, penalty multipliers, and server load factor. Lets you reset any identifier with one click.

![Dashboard screenshot — identifier table with type badges, counts, penalty column, and a load bar]

## Quick start

```bash
# From this directory
npm install
ADMIN_TOKEN=mysecret npm start
# → http://localhost:3001
```

Open `http://localhost:3001`, enter your token in the **Connect** box, and you'll see live state for any app that shares the same Redis instance.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port the dashboard listens on |
| `REDIS_URL` | `redis://localhost:6379` | Redis to read state from |
| `ADMIN_TOKEN` | `dev-token-change-in-production` | Static bearer token for auth |

## API endpoints

All routes require `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/identifiers` | Paginated list of all active identifiers |
| `GET` | `/admin/identifier/:type/:value` | Full state for one identifier |
| `DELETE` | `/admin/identifier/:type/:value` | Clear window + penalty for one identifier |
| `GET` | `/admin/load` | Current CPU load metrics |

## Wire your own dashboard in production

1. **Copy the three inspection helpers** (`listActiveIdentifiers`, `inspectIdentifier`, `resetIdentifier`) into your own Express app — they're plain async functions that take a Redis client.
2. **Protect them properly** — the static bearer token here is example-grade. In production use your existing session/JWT auth middleware, scope the routes to an admin role, and put them behind your internal network or VPN.
3. **Add pagination** — `listActiveIdentifiers` returns a `cursor` you can pass back as `?cursor=<value>` to page through large key spaces.
4. **Stream instead of polling** — for lower latency, replace the 5 s poll with Server-Sent Events or a WebSocket that emits on `onViolation` / `onAllowed` callbacks.

## Auth note

> **This example uses a static bearer token stored in an environment variable. That is intentional example-grade auth. Do not expose this dashboard to the public internet without replacing it with your production authentication system.**
