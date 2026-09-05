import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

import { attachUser, ensureGuest } from './auth.js';
import { createRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

/** Shown to visitors when the chat can't start — usually a missing database. */
const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Support chat unavailable</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0d1220; color:#e8ecf6; }
  .card { max-width:420px; padding:32px; text-align:center; line-height:1.6; }
  h1 { font-size:19px; margin:0 0 8px; }
  p { color:#94a1bd; font-size:14px; margin:0; }
</style></head>
<body><div class="card">
  <h1>Support chat is temporarily unavailable</h1>
  <p>We couldn't start a conversation just now. Please try again in a few minutes.</p>
</div></body></html>`;

/** Builds the Express app. Used by the local server and the Vercel function. */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Image uploads arrive as a raw binary body; everything else is JSON.
  // Both parsers answer their own failures: a malformed body or an oversized
  // upload must never reach the error middleware, which is unreliable inside
  // Vercel's function runtime.
  const parsers = [
    express.raw({ type: ['image/*'], limit: '4mb' }),
    express.json({ limit: '64kb' }),
  ];
  for (const parse of parsers) {
    app.use((req, res, next) =>
      parse(req, res, (err) => {
        if (!err) return next();
        console.error('[body]', err.type ?? err.message);
        const tooBig = err.type === 'entity.too.large';
        res.status(tooBig ? 413 : 400).json({
          error: tooBig ? 'That upload is too large' : 'Malformed request body',
        });
      })
    );
  }
  app.use(cookieParser());
  app.use(attachUser);

  app.use('/api', createRouter());

  // Customers never sign in: hitting the chat mints a guest session on the spot.
  // A visitor must never see a stack trace, so this answers its own failures.
  app.get(['/', '/chat'], async (req, res) => {
    try {
      if (req.user?.role === 'admin') return res.redirect('/admin');
      await ensureGuest(req, res);
      res.sendFile(join(PUBLIC_DIR, 'chat.html'));
    } catch (err) {
      console.error('[chat]', err);
      if (!res.headersSent) res.status(503).type('html').send(UNAVAILABLE_PAGE);
    }
  });

  // The agent console is the only gated surface.
  app.get('/admin', (req, res) => {
    if (req.user?.role !== 'admin') return res.redirect('/admin/login');
    res.sendFile(join(PUBLIC_DIR, 'admin.html'));
  });

  app.get('/admin/login', (req, res) => {
    if (req.user?.role === 'admin') return res.redirect('/admin');
    res.sendFile(join(PUBLIC_DIR, 'admin-login.html'));
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    // Misconfiguration is the operator's problem to fix, so say what's wrong.
    if (err?.code === 'CONFIG') return res.status(503).json({ error: err.message });
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
