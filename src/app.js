import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

import { attachUser, ensureGuest } from './auth.js';
import { createRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

/** Builds the Express app. Used by the local server and the Vercel function. */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.use('/api', createRouter());

  // Customers never sign in: hitting the chat mints a guest session on the spot.
  app.get(['/', '/chat'], async (req, res, next) => {
    try {
      if (req.user?.role === 'admin') return res.redirect('/admin');
      await ensureGuest(req, res);
      res.sendFile(join(PUBLIC_DIR, 'chat.html'));
    } catch (err) {
      next(err);
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
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
