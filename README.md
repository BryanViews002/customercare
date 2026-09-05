# Customer Care Chat

A private one-to-one support chat: every visitor gets their own thread with the
support team, and agents work all of those threads from a single inbox.

Customers never sign in. Loading the page mints a guest identity and a session
cookie, which is what makes the thread private and lets the visitor return to it
later in the same browser. Only agents have credentials.

Built to run on Vercel: stateless serverless functions, Postgres for storage,
and polling instead of WebSockets.

## Running it locally

```
npm install
npm start
```

That's it — no database to install. With no `POSTGRES_URL` set, the app starts
an in-process Postgres (PGlite) under `data/pgdata`. Create a `.env` (copy
`.env.example`) to set your agent login:

```
ADMIN_EMAIL=you@example.com
ADMIN_NAME=Support Team
ADMIN_PASSWORD=pick-a-strong-one
```

`npm start` loads `.env` itself, so it works the same in cmd, PowerShell and
bash. `.env` is gitignored.

| URL            | Who       | What                                     |
| -------------- | --------- | ---------------------------------------- |
| `/`            | Customers | Their private thread — no account needed |
| `/admin`       | Agents    | Inbox of every conversation              |
| `/admin/login` | Agents    | Sign-in (the only gated surface)         |

## Deploying to Vercel

1. **Create the database.** In your Vercel project: **Storage → Create
   Database → Neon (Postgres)**. Vercel injects `DATABASE_URL` and
   `POSTGRES_URL` into the project automatically — the app reads either.
2. **Add the agent credentials.** Project **Settings → Environment Variables**:
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `ADMIN_NAME`.
3. **Redeploy.** The schema is created and the admin account seeded on the first
   request after deploy.

`vercel.json` rewrites every path to `api/index.js`, which exports the Express
app. There is no build step.

The admin account is seeded only when no user with that email exists. Changing
`ADMIN_PASSWORD` later does **not** update it — delete the `users` row and
redeploy, or update the hash directly.

## Why polling, not WebSockets

Vercel functions are short-lived and cannot hold a socket open, so the client
asks `GET /api/conversations/:id/poll?after=<newest message it holds>` every
2.5s and gets back new messages plus the peer's typing, read and presence state
in the same response. The loop drops to 15s while the tab is hidden and wakes
immediately on focus, which keeps invocation counts down.

Practical consequences: messages land within a couple of seconds rather than
instantly, presence means "seen in the last 20 seconds", and each open tab costs
roughly 24 function invocations per minute. If you later want true push, the
change is contained — swap the poll loop in `public/js/thread.js` for a hosted
realtime service.

## What it does

**Customer side** — the page is the chat and nothing else: no header bar, no
account label, no status chrome. A new visitor sees "How can we help?" over a
grid of common questions; tapping one sends it as their opening message. After
that it's a normal thread — Enter to send, typing indicators, "Seen" receipts,
and history that pages in as you scroll up.

**Images** — both sides can attach one. Use the paperclip, paste a screenshot
straight into the composer, or drag a file onto the thread; anything in the
composer at the time becomes the caption. Click an image to open it full size.

Edit `COMMON_QUESTIONS` at the top of [public/js/chat.js](public/js/chat.js) to
match what your customers actually ask.

**Agent side** — inbox sorted by latest activity with unread badges, per-visitor
online dots, search across name and subject, open/resolved filters, and a
resolve toggle that closes the customer's composer. Image-only messages show as
"📷 Photo" in the inbox preview.

## How privacy is enforced

Every route that touches a conversation passes through
`authorizeConversation()` in [src/service.js](src/service.js): a customer may
only reach the conversation whose `user_id` is their own, and only
`role = 'admin'` may reach anyone else's. Message text is rendered with
`textContent` throughout — never `innerHTML`.

Images get the same treatment. They are stored in the database, not a public
bucket, and `GET /api/attachments/:id` runs the same authorization before
returning a byte — so an image URL is useless to anyone outside that
conversation. Responses are marked `Cache-Control: private` so no shared proxy
holds a copy.

## Layout

```
api/index.js       Vercel entry point (exports the Express app)
vercel.json        rewrites every path to that function
server.js          local dev server
src/app.js         Express app: middleware, page routes, static files
src/db.js          Postgres schema, queries, admin seeding
src/auth.js        password hashing, sessions, guest provisioning
src/service.js     authorization, validation, rate limit, message writes
src/routes.js      REST API including the polling endpoint
public/            chat.html, admin.html, admin-login.html + js/css
test/e2e.mjs       end-to-end checks against a running server
```

## Tests

With the server running:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='the-one-you-used' node test/e2e.mjs
```

36 checks covering the guest flow, agent sign-in, delivery both ways through the
poll endpoint, image upload and authorized retrieval, typing, read receipts,
resolve/reopen, and the privacy boundary between two visitors. Point `BASE` at your deployment to run them against
production.

## Known limits

- The rate limit is in-memory per warm instance, so on serverless it is a speed
  bump rather than a hard ceiling. Move it to the database if you need a real one.
- Images are downscaled in the browser to a 1600px long edge and capped at 3 MB,
  which keeps a phone photo well under Vercel's request limit. They live in
  Postgres, so they count against your Neon storage — roughly 1,500 typical
  screenshots on the free tier. Move `attachments.data` to object storage if you
  outgrow that; only `src/db.js` and the attachment route would change.
- Guest threads are keyed to a browser cookie: clearing cookies starts a new
  thread. (`PATCH /api/me` renames a guest — wired up and tested, but not
  surfaced in the UI.)
- Cookies are marked `secure` when `NODE_ENV=production`, which Vercel sets.
