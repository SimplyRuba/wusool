import express from 'express';
import cors from 'cors';
import { api } from './routes/api.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

/* One line per request. The running log is part of the demo's credibility:
   judges can watch the cascade fire live. */
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const flag = res.statusCode >= 400 ? '!' : ' ';
    console.log(`${flag} ${req.method.padEnd(4)} ${req.originalUrl.padEnd(38)} ${res.statusCode} ${ms}ms`);
  });
  next();
});

app.use('/api', api);

/* The published artifact runs under a CSP that blocks every external host, so it
   can never call localhost. Serving the app from the API origin sidesteps that
   entirely and makes the demo a single URL. */
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
app.use(express.static(FRONTEND));
app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'no such route' } }));
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('unhandled:', err);
  res.status(500).json({ error: { code: 'internal', message: err?.message ?? 'error' } });
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`\n  wusool backend  ->  http://localhost:${PORT}`);
  const llm = process.env.GEMINI_API_KEY ? 'Gemini 2.5 Flash (free) + rule fallback'
    : process.env.ANTHROPIC_API_KEY ? 'Claude Sonnet 5 + rule fallback'
    : 'rule engine (no API key set)';
  console.log(`  parser          ->  ${llm}`);
  console.log(`  app             ->  http://localhost:${PORT}/`);
  console.log(`  health          ->  http://localhost:${PORT}/api/health\n`);
});
