// ── LOGGER ────────────────────────────────────────────────────────────────────
// One structured JSON logger for the whole app, written to stdout.
// Render captures stdout automatically — no file paths, no rotation to manage.
//
// Levels used in this app:
//   error  — something failed and needs a human to look (DB errors, upload
//            failures, uncaught exceptions)
//   warn   — degraded but working (R2 not configured -> local disk fallback,
//            rate limit hit, invalid/expired token)
//   info   — normal lifecycle events (server start, DB connected, login success)
//   debug  — verbose detail, off by default (set LOG_LEVEL=debug locally)
//
// In local dev (NODE_ENV !== 'production') logs are pretty-printed if
// pino-pretty is installed; otherwise falls back to plain JSON — never crashes
// dev just because a devDependency wasn't installed.
const pino = require('pino');

let transport;
if (process.env.NODE_ENV !== 'production') {
  try {
    require.resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch { /* pino-pretty not installed — plain JSON in dev is fine */ }
}

const log = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  transport,
});

module.exports = log;
