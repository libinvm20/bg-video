import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import argon2 from 'argon2';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { db } from './database.js';
import { getFrontPath, mediaRequest } from './mediamtx.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = join(sourceDirectory, '../../frontend');
const sessionCookie = 'camera_session';
const sessionTtlMs = Number(process.env.SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;
const viewerTtlSeconds = Math.min(Math.max(Number(process.env.VIEW_TOKEN_TTL_SECONDS ?? 3600), 60), 3600);
const production = process.env.NODE_ENV === 'production';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const csrfForSession = (token) => createHmac('sha256', 'private-camera-csrf-v1').update(token).digest('base64url');

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

function createSessionCookie(res, token, maxAge) {
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookie, {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    path: '/',
  });
}

function currentSession(req, _res, next) {
  const token = req.get('cookie')
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);

  req.auth = null;
  if (token) {
    const session = db.prepare(`
      SELECT sessions.id AS session_id, sessions.csrf_token_hash, sessions.expires_at,
             users.id AS user_id, users.username, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.session_token_hash = ? AND sessions.expires_at > ?
    `).get(hash(token), new Date().toISOString());

    if (session) req.auth = { ...session, token };
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requirePageAuth(req, res, next) {
  if (!req.auth) return res.redirect('/login');
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Invalid request origin' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
  }
  next();
}

function requireCsrf(req, res, next) {
  const csrfToken = req.get('x-csrf-token');
  if (!req.auth || !safeEqual(hash(csrfToken ?? ''), req.auth.csrf_token_hash)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

function parseNetworkBytes() {
  const rows = readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2);
  let received = 0;
  let sent = 0;

  for (const row of rows) {
    const [interfaceName, values] = row.split(':');
    if (!values || interfaceName.trim() === 'lo') continue;
    const counters = values.trim().split(/\s+/).map(Number);
    received += counters[0] ?? 0;
    sent += counters[8] ?? 0;
  }
  return { received, sent };
}

function readCgroupFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

let previousNetwork = null;
let previousCpu = null;

function collectServerStats() {
  const now = process.hrtime.bigint();
  const network = parseNetworkBytes();
  const networkRate = previousNetwork
    ? {
        receivedBytesPerSecond: Math.max(0, Math.round((network.received - previousNetwork.received) / Number(now - previousNetwork.time) * 1e9)),
        sentBytesPerSecond: Math.max(0, Math.round((network.sent - previousNetwork.sent) / Number(now - previousNetwork.time) * 1e9)),
      }
    : null;
  previousNetwork = { ...network, time: now };

  const cpuStat = readCgroupFile('/sys/fs/cgroup/cpu.stat');
  const usageMicros = Number(cpuStat?.match(/^usage_usec\s+(\d+)$/m)?.[1]);
  const cpuLimit = readCgroupFile('/sys/fs/cgroup/cpu.max')?.split(/\s+/);
  const cpuCores = cpuLimit?.[0] && cpuLimit[0] !== 'max'
    ? Number(cpuLimit[0]) / Number(cpuLimit[1])
    : (Number(process.env.CPU_COUNT) || availableParallelism());
  const cpuPercent = Number.isFinite(usageMicros) && previousCpu
    ? Math.max(0, Math.min(100, ((usageMicros - previousCpu.usageMicros) / (Number(now - previousCpu.time) / 1000) / cpuCores) * 100))
    : null;
  if (Number.isFinite(usageMicros)) previousCpu = { usageMicros, time: now };

  const memoryUsed = Number(readCgroupFile('/sys/fs/cgroup/memory.current'));
  const memoryLimitText = readCgroupFile('/sys/fs/cgroup/memory.max');
  const memoryLimit = memoryLimitText && memoryLimitText !== 'max' ? Number(memoryLimitText) : null;

  return {
    cpuPercent,
    memory: Number.isFinite(memoryUsed)
      ? { usedBytes: memoryUsed, limitBytes: memoryLimit, percent: memoryLimit ? (memoryUsed / memoryLimit) * 100 : null }
      : null,
    network: networkRate,
    sampledAt: new Date().toISOString(),
  };
}

async function updateCameraState(path) {
  const online = Boolean(path?.ready);
  const current = db.prepare('SELECT online, last_connection_at FROM camera_state WHERE id = 1').get();
  const now = new Date().toISOString();

  if (Number(current.online) !== Number(online)) {
    const lastConnectionAt = online ? now : current.last_connection_at;
    db.prepare('UPDATE camera_state SET online = ?, last_connection_at = ? WHERE id = 1')
      .run(Number(online), lastConnectionAt);
    db.prepare('INSERT INTO stream_events (event_type, timestamp, details) VALUES (?, ?, ?)')
      .run(online ? 'publisher_connected' : 'publisher_disconnected', now, JSON.stringify({ path: 'front' }));
    return { online, lastConnectionAt };
  }
  return { online, lastConnectionAt: current.last_connection_at };
}

async function getCameraSnapshot() {
  const path = await getFrontPath();
  const state = await updateCameraState(path);
  const readyTime = path?.readyTime ? Date.parse(path.readyTime) : NaN;
  const streamUptimeSeconds = state.online && Number.isFinite(readyTime)
    ? Math.max(0, Math.floor((Date.now() - readyTime) / 1000))
    : null;

  return {
    online: state.online,
    streamAvailable: state.online,
    connectionStatus: state.online ? 'connected' : 'disconnected',
    cameraName: 'Front Camera (Selfie Camera)',
    lastConnectionTime: state.lastConnectionAt,
    streamUptimeSeconds,
    activeViewers: Array.isArray(path?.readers) ? path.readers.length : 0,
  };
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict();

const endViewerSchema = z.object({ sessionId: z.string().uuid() }).strict();

export async function initializeAdmin() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount > 0) return;

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) {
    throw new Error('Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters before first startup.');
  }

  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, await argon2.hash(password), 'admin', new Date().toISOString());
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use(currentSession);
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
  });

  app.get('/_health', async (_req, res) => {
    try {
      await mediaRequest('/v3/config/global/get');
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.post('/internal/mediamtx/auth', async (req, res) => {
    const { user, password, action, path, protocol } = req.body ?? {};

    if (action === 'api'
      && user === (process.env.MEDIAMTX_API_USER ?? 'mediamtx-api')
      && safeEqual(password, process.env.MEDIAMTX_API_PASSWORD ?? '')) {
      return res.sendStatus(200);
    }

    if (action === 'publish'
      && path === 'front'
      && protocol === 'rtsp'
      && user === 'camera'
      && safeEqual(password, process.env.CAMERA_PUBLISH_PASSWORD ?? '')) {
      return res.sendStatus(200);
    }

    if (action === 'read' && path === 'front' && protocol === 'webrtc' && user === 'viewer' && typeof password === 'string') {
      const viewer = db.prepare(`
        SELECT id, expires_at FROM viewer_sessions
        WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?
      `).get(hash(password), new Date().toISOString());

      if (viewer) {
        db.prepare('UPDATE viewer_sessions SET started_at = COALESCE(started_at, ?) WHERE id = ?')
          .run(new Date().toISOString(), viewer.id);
        return res.status(200).json({ expireAt: viewer.expires_at });
      }
    }

    return res.sendStatus(401);
  });

  app.post('/api/auth/login', requireSameOrigin, loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid username or password' });

    const user = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(parsed.data.username);
    const valid = user ? await argon2.verify(user.password_hash, parsed.data.password) : false;
    if (!valid) {
      if (!user) await argon2.hash(parsed.data.password);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = csrfForSession(sessionToken);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + sessionTtlMs);
    db.prepare(`
      INSERT INTO sessions (id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), user.id, hash(sessionToken), hash(csrfToken), expiresAt.toISOString(), createdAt.toISOString());
    createSessionCookie(res, sessionToken, sessionTtlMs);
    res.json({ authenticated: true, csrfToken, user: { username: user.username, role: user.role } });
  });

  app.get('/api/auth/session', (req, res) => {
    if (!req.auth) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      csrfToken: csrfForSession(req.auth.token),
      user: { username: req.auth.username, role: req.auth.role },
      sessionExpiresAt: req.auth.expires_at,
    });
  });

  app.post('/api/auth/logout', requireAuth, requireSameOrigin, requireCsrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.auth.session_id);
    clearSessionCookie(res);
    res.json({ loggedOut: true });
  });

  app.get('/api/camera/status', requireAuth, async (_req, res) => {
    try {
      res.json(await getCameraSnapshot());
    } catch {
      res.status(503).json({ error: 'Camera status is temporarily unavailable' });
    }
  });

  app.get('/api/camera/info', requireAuth, (req, res) => {
    res.json({
      path: 'front',
      cameraName: 'Front Camera (Selfie Camera)',
      publishingProtocol: 'RTSPS',
      publishingUrl: `${req.protocol === 'https' ? 'rtsps' : 'rtsps'}://${req.get('host')}:8322/front`,
      expectedVideoCodec: 'H.264',
    });
  });

  app.post('/api/camera/view-token', requireAuth, requireSameOrigin, requireCsrf, (req, res) => {
    const token = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + viewerTtlSeconds * 1000);
    db.prepare(`
      INSERT INTO viewer_sessions (id, user_id, token_hash, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, req.auth.user_id, hash(token), issuedAt.toISOString(), expiresAt.toISOString());

    res.json({
      endpoint: '/front/whep',
      username: 'viewer',
      password: token,
      sessionId,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.post('/api/camera/view-session/end', requireAuth, requireSameOrigin, requireCsrf, (req, res) => {
    const parsed = endViewerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid viewer session' });
    db.prepare(`
      UPDATE viewer_sessions SET ended_at = ?
      WHERE id = ? AND user_id = ? AND ended_at IS NULL
    `).run(new Date().toISOString(), parsed.data.sessionId, req.auth.user_id);
    res.sendStatus(204);
  });

  app.get('/api/server/status', requireAuth, async (_req, res) => {
    try {
      const mediaPath = await getFrontPath();
      res.json({
        status: 'online',
        uptimeSeconds: Math.floor(process.uptime()),
        cameraOnline: Boolean(mediaPath?.ready),
      });
    } catch {
      res.status(503).json({ status: 'degraded', uptimeSeconds: Math.floor(process.uptime()) });
    }
  });

  app.get('/api/server/health', requireAuth, async (_req, res) => {
    try {
      await mediaRequest('/v3/config/global/get');
      db.prepare('SELECT 1').get();
      res.json({ status: 'healthy', database: 'ok', mediaServer: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unknown', mediaServer: 'unavailable' });
    }
  });

  app.get('/api/server/stats', requireAuth, async (_req, res) => {
    try {
      const mediaPath = await getFrontPath();
      res.json({ ...collectServerStats(), activeViewers: Array.isArray(mediaPath?.readers) ? mediaPath.readers.length : 0 });
    } catch {
      res.status(503).json({ error: 'Server statistics are temporarily unavailable' });
    }
  });

  app.get('/login', (_req, res) => res.sendFile(join(frontendDirectory, 'login.html')));
  app.get('/', requirePageAuth, (_req, res) => res.sendFile(join(frontendDirectory, 'index.html')));
  app.get('/live', requirePageAuth, (_req, res) => res.sendFile(join(frontendDirectory, 'live.html')));
  app.use('/assets', express.static(join(frontendDirectory, 'assets'), { fallthrough: false, maxAge: production ? '1h' : 0 }));

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (error?.status === 404) return res.status(404).json({ error: 'Not found' });
    console.error('Request failed:', error?.message ?? 'unknown error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

async function pollCamera() {
  try {
    await getCameraSnapshot();
  } catch {
    // A media-server outage is reported by the health and camera APIs.
  }
}

async function start() {
  await initializeAdmin();
  const app = createApp();
  const server = createServer(app);
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Camera backend listening on ${port}`));
  await pollCamera();
  setInterval(pollCamera, 5000).unref();

  const shutdown = () => server.close(() => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}