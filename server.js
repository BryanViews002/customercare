// Local development server. On Vercel, api/index.js is the entry point instead.
import { createApp } from './src/app.js';

const PORT = Number(process.env.PORT) || 3000;

createApp().listen(PORT, () => {
  console.log(`Customer care chat listening on http://localhost:${PORT}`);
  console.log(`  customers -> http://localhost:${PORT}/`);
  console.log(`  support   -> http://localhost:${PORT}/admin`);
});
