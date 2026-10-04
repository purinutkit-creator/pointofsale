import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config.js';
import { initDb } from './db/index.js';
import { initRealtime, emitBranch } from './realtime.js';
import { setNotifyEmitter } from './services/notify.js';
import { syncPermissionCatalog } from './services/bootstrap.js';
import { deviceContext } from './middleware/auth.js';
import { HttpError } from './lib/errors.js';
import { startJobs } from './jobs/index.js';
import authRoutes from './routes/auth.js';
import memberAppRoutes from './routes/memberApp.js';
import kitchenRoutes from './routes/kitchen.js';
import printerRoutes from './routes/printers.js';
import orderRoutes from './routes/orders.js';
import catalogRoutes from './routes/catalog.js';
import shiftRoutes from './routes/shifts.js';
import memberRoutes from './routes/members.js';
import staffRoutes from './routes/staff.js';
import inventoryRoutes from './routes/inventory.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'http://localhost:*', 'http://127.0.0.1:*'],
        'font-src': ["'self'", 'data:', 'https:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https:'],
        'script-src': ["'self'"],
        'media-src': ["'self'", 'data:', 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', deviceContext);
  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // public / device-scoped routers first, staff-session routers after
  for (const r of [authRoutes, memberAppRoutes, kitchenRoutes, printerRoutes, orderRoutes, catalogRoutes, shiftRoutes, memberRoutes, staffRoutes, inventoryRoutes, reportRoutes, adminRoutes]) {
    app.use('/api', r);
  }
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API not found')));

  // static client (built with Vite) + SPA fallback
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist, {
      index: false,
      setHeaders: (res, file) => {
        if (file.endsWith('sw.js') || file.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
        else if (file.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(config.clientDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('Client not built yet. Run: npm run build'));
  }

  // error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON ไม่ถูกต้อง', code: 'BAD_JSON' });
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'ข้อมูลซ้ำในระบบ', code: 'DUPLICATE' });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'ไฟล์ใหญ่เกินไป', code: 'TOO_LARGE' });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่', code: 'SERVER_ERROR' });
  });
  return app;
}

export function start() {
  initDb();
  syncPermissionCatalog();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  setNotifyEmitter(emitBranch);
  startJobs();
  server.listen(config.port, config.host, () => console.log(`[pos] server ready on http://${config.host}:${config.port}`));
  const shutdown = () => { console.log('[pos] shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) start();
