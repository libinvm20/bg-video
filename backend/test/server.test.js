import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'private-camera-test-'));
process.env.DB_PATH = join(temporaryDirectory, 'camera.sqlite');
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.CAMERA_PUBLISH_PASSWORD = 'camera-publish-test-password';
process.env.MEDIAMTX_API_PASSWORD = 'mediamtx-api-test-password';

const { createApp, initializeAdmin } = await import('../src/server.js');
let server;
let baseUrl;

before(async () => {
  await initializeAdmin();
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('login, protected endpoints, and CSRF validation', async () => {
  const protectedPage = await fetch(`${baseUrl}/live`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/login');

  const anonymous = await fetch(`${baseUrl}/api/camera/view-token`, { method: 'POST' });
  assert.equal(anonymous.status, 401);

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'test-admin', password: 'correct-horse-battery-staple' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.csrfToken, loginBody.csrfToken);

  const invalidCsrf = await fetch(`${baseUrl}/api/camera/view-token`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: baseUrl, 'x-csrf-token': 'invalid' },
    body: '{}',
  });
  assert.equal(invalidCsrf.status, 403);

  const viewTokenResponse = await fetch(`${baseUrl}/api/camera/view-token`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: baseUrl,
      'x-csrf-token': sessionBody.csrfToken,
    },
    body: '{}',
  });
  assert.equal(viewTokenResponse.status, 200);
  const viewToken = await viewTokenResponse.json();
  assert.equal(viewToken.endpoint, '/front/whep');

  const authorizedViewer = await fetch(`${baseUrl}/internal/mediamtx/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: viewToken.username, password: viewToken.password, action: 'read', path: 'front', protocol: 'webrtc' }),
  });
  assert.equal(authorizedViewer.status, 200);
  assert.ok((await authorizedViewer.json()).expireAt);

  const wrongViewerPath = await fetch(`${baseUrl}/internal/mediamtx/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: viewToken.username, password: viewToken.password, action: 'read', path: 'rear', protocol: 'webrtc' }),
  });
  assert.equal(wrongViewerPath.status, 401);

  const ended = await fetch(`${baseUrl}/api/camera/view-session/end`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: baseUrl,
      'x-csrf-token': sessionBody.csrfToken,
    },
    body: JSON.stringify({ sessionId: viewToken.sessionId }),
  });
  assert.equal(ended.status, 204);

  const revokedViewer = await fetch(`${baseUrl}/internal/mediamtx/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: viewToken.username, password: viewToken.password, action: 'read', path: 'front', protocol: 'webrtc' }),
  });
  assert.equal(revokedViewer.status, 401);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      cookie,
      origin: baseUrl,
      'x-csrf-token': sessionBody.csrfToken,
    },
  });
  assert.equal(logout.status, 200);

  const loggedOut = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  assert.equal((await loggedOut.json()).authenticated, false);
});

test('MediaMTX publishing is restricted to the configured account and front path', async () => {
  const publish = (user, password, path) => fetch(`${baseUrl}/internal/mediamtx/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password, action: 'publish', path, protocol: 'rtsp' }),
  });

  assert.equal((await publish('camera', 'camera-publish-test-password', 'front')).status, 200);
  assert.equal((await publish('camera', 'wrong-password', 'front')).status, 401);
  assert.equal((await publish('camera', 'camera-publish-test-password', 'rear')).status, 401);
});