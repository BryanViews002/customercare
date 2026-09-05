import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';

import { sessions } from './src/db.js';
import { attachUser, ensureGuest, seedAdmin } from './src/auth.js';
import { createRouter } from './src/routes.js';
import { createService } from './src/service.js';
import { attachRealtime } from './src/realtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(__dirname, 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { serveClient: true });
const service = createService(io);

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(attachUser);

app.use('/api', createRouter(service));

// Customers never sign in: hitting the chat mints a guest session on the spot.
app.get(['/', '/chat'], (req, res) => {
  if (req.user?.role === 'admin') return res.redirect('/admin');
  ensureGuest(req, res);
  res.sendFile(join(PUBLIC_DIR, 'chat.html'));
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

attachRealtime(io, service);

sessions.purgeExpired();
setInterval(() => sessions.purgeExpired(), 60 * 60 * 1000).unref();

await seedAdmin();

httpServer.listen(PORT, () => {
  console.log(`Customer care chat listening on http://localhost:${PORT}`);
  console.log(`  customers -> http://localhost:${PORT}/chat`);
  console.log(`  support   -> http://localhost:${PORT}/admin`);
});
