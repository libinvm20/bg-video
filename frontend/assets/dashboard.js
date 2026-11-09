const $ = (selector) => document.querySelector(selector);
let csrfToken = '';
let polling = false;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function formatMemory(memory) {
  if (!memory) return '--';
  const used = memory.usedBytes / 1024 ** 3;
  if (Number.isFinite(memory.limitBytes)) return `${used.toFixed(1)} / ${(memory.limitBytes / 1024 ** 3).toFixed(1)} GB`;
  return `${used.toFixed(1)} GB`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) {
    location.replace('/login');
    throw new Error('Your session has expired.');
  }
  const result = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error ?? 'A server request failed.');
  return result;
}

function setCameraStatus(camera) {
  const indicator = $('#camera-indicator');
  indicator.classList.toggle('is-online', camera.online);
  indicator.classList.toggle('is-offline', !camera.online);
  $('#camera-state-label').textContent = camera.online ? 'Camera online' : 'Camera Offline';
  $('#connection-label').textContent = camera.online ? 'Publisher connected' : 'Waiting for publisher';
  $('#stream-uptime').textContent = camera.online ? formatDuration(camera.streamUptimeSeconds) : '--';
  $('#active-viewers').textContent = Number.isFinite(camera.activeViewers) ? String(camera.activeViewers) : '--';
  $('#last-connection').textContent = camera.lastConnectionTime
    ? new Date(camera.lastConnectionTime).toLocaleString()
    : 'Never recorded';
}

async function refreshDashboard() {
  if (polling) return;
  polling = true;
  const error = $('#dashboard-error');
  error.hidden = true;

  try {
    const [camera, server, stats, health] = await Promise.all([
      api('/api/camera/status'),
      api('/api/server/status'),
      api('/api/server/stats'),
      api('/api/server/health'),
    ]);
    setCameraStatus(camera);
    $('#cpu-usage').textContent = Number.isFinite(stats.cpuPercent) ? `${Math.round(stats.cpuPercent)}%` : 'Sampling';
    $('#memory-usage').textContent = formatMemory(stats.memory);
    $('#network-receive').textContent = formatBytes(stats.network?.receivedBytesPerSecond);
    $('#network-send').textContent = formatBytes(stats.network?.sentBytesPerSecond);
    $('#server-uptime').textContent = formatDuration(server.uptimeSeconds);
    $('#server-state').textContent = server.status === 'online' ? 'Online' : 'Degraded';
    $('#server-state').classList.toggle('state-warning', server.status !== 'online');
    $('#media-health').textContent = health.mediaServer === 'ok' ? 'Connected' : 'Unavailable';
    $('#media-health').classList.toggle('text-warning', health.mediaServer !== 'ok');
    $('#updated-at').textContent = `UPDATED ${new Date().toLocaleTimeString()}`;
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    polling = false;
  }
}

async function initialize() {
  try {
    const session = await api('/api/auth/session');
    if (!session.authenticated) return location.replace('/login');
    csrfToken = session.csrfToken;
    $('#account-name').textContent = session.user.username;
    $('#session-expiry').textContent = `Session expires ${new Date(session.sessionExpiresAt).toLocaleTimeString()}`;
  } catch {
    return;
  }

  $('#logout-button').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
      });
    } finally {
      location.replace('/login');
    }
  });

  await refreshDashboard();
  window.setInterval(refreshDashboard, 5000);
}

initialize();