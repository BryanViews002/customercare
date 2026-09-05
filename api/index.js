// Vercel serverless entry point: every route is rewritten here by vercel.json.
import { createApp } from '../src/app.js';

// A stray rejection would otherwise kill the whole invocation with an opaque
// FUNCTION_INVOCATION_FAILED. Log it and let the request finish instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

export default createApp();
