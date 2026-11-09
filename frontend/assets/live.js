const $ = (selector) => document.querySelector(selector);
const video = $('#camera-video');
const stage = $('#video-stage');
let csrfToken = '';
let viewerSessionId = null;
let peer = null;
let whepSessionUrl = null;
let viewerCredentials = null;
let playbackRequested = false;
let starting = false;
let retryTimer = null;
let retryCount = 0;

function setState(state, title, detail, loading = false) {
  stage.dataset.state = state;
  $('#overlay-title').textContent = title;
  $('#overlay-detail').textContent = detail;
  $('#overlay-spinner').hidden = !loading;
  $('#video-overlay').hidden = state === 'live';
  $('#live-state').textContent = title;
  $('#live-state-dot').className = `live-dot is-${state}`;
  $('#start-button').disabled = starting || (state === 'live' && playbackRequested);
  $('#stop-button').disabled = !playbackRequested;
  $('#audio-button').disabled = state !== 'live';
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

function basicAuthorization(credentials) {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

function parseIceServers(linkHeader) {
  if (!linkHeader) return [];
  return linkHeader.split(', ').map((link) => {
    const match = link.match(/^<(.+?)>; rel="ice-server"(?:; username="(.*?)"; credential="(.*?)"; credential-type="password")?/i);
    if (!match) return null;
    const server = { urls: [match[1]] };
    if (match[2] !== undefined) {
      server.username = JSON.parse(`"${match[2]}"`);
      server.credential = JSON.parse(`"${match[3]}"`);
      server.credentialType = 'password';
    }
    return server;
  }).filter(Boolean);
}

function waitForIceGathering(connection, timeoutMs = 8000) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(finish, timeoutMs);
    function finish() {
      window.clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    }
    function onStateChange() {
      if (connection.iceGatheringState === 'complete') finish();
    }
    connection.addEventListener('icegatheringstatechange', onStateChange);
  });
}

async function releaseConnection() {
  const connection = peer;
  const sessionUrl = whepSessionUrl;
  const credentials = viewerCredentials;
  const sessionId = viewerSessionId;
  peer = null;
  whepSessionUrl = null;
  viewerCredentials = null;
  viewerSessionId = null;
  video.pause();
  video.srcObject = null;
  if (connection) connection.close();

  if (sessionUrl && credentials) {
    await fetch(sessionUrl, {
      method: 'DELETE',
      headers: { authorization: basicAuthorization(credentials) },
      credentials: 'same-origin',
    }).catch(() => {});
  }
  if (sessionId) {
    await api('/api/camera/view-session/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
}

function scheduleRetry(delay = Math.min(1500 * (2 ** retryCount), 12000)) {
  if (!playbackRequested || retryTimer) return;
  retryCount = Math.min(retryCount + 1, 4);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    startPlayback();
  }, delay);
}

function reconnectAfterFailure() {
  if (!peer || !playbackRequested) return;
  setState('reconnecting', 'Reconnecting', 'The stream connection was interrupted.', true);
  releaseConnection().finally(() => scheduleRetry());
}

async function startPlayback() {
  if (!playbackRequested || starting) return;
  starting = true;
  setState('connecting', 'Connecting', 'Checking the front camera stream.', true);
  $('#player-error').hidden = true;

  try {
    const status = await api('/api/camera/status');
    if (!status.online) {
      setState('offline', 'Camera Offline', 'Waiting for the phone to publish the front camera.', false);
      await releaseConnection();
      scheduleRetry(5000);
      return;
    }

    const token = await api('/api/camera/view-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: '{}',
    });
    viewerCredentials = { username: token.username, password: token.password };
    viewerSessionId = token.sessionId;
    const endpoint = new URL(token.endpoint, location.origin);
    const authorization = basicAuthorization(viewerCredentials);
    const iceResponse = await fetch(endpoint, {
      method: 'OPTIONS',
      credentials: 'same-origin',
      headers: { authorization },
    });
    if (!iceResponse.ok) throw new Error('The media server ICE configuration is unavailable.');
    peer = new RTCPeerConnection({
      iceServers: parseIceServers(iceResponse.headers.get('link')),
      sdpSemantics: 'unified-plan',
    });
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });

    peer.ontrack = async (event) => {
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      try {
        await video.play();
        $('#tap-to-play').hidden = true;
      } catch {
        $('#tap-to-play').hidden = false;
        $('#overlay-title').textContent = 'Tap to play';
        $('#overlay-detail').textContent = 'Your browser needs a gesture before starting video playback.';
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer?.connectionState === 'connected') {
        retryCount = 0;
        setState('live', 'Live', 'Connected to the front camera stream.');
      } else if (['failed', 'disconnected', 'closed'].includes(peer?.connectionState) && playbackRequested) {
        reconnectAfterFailure();
      }
    };
    peer.oniceconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(peer?.iceConnectionState) && playbackRequested) {
        reconnectAfterFailure();
      }
    };
    peer.ontrackerror = () => {
      $('#player-error').textContent = 'The browser could not decode the incoming video.';
      $('#player-error').hidden = false;
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization,
        'content-type': 'application/sdp',
        accept: 'application/sdp',
      },
      body: peer.localDescription.sdp,
    });

    if (!response.ok) {
      if (response.status === 404 || response.status === 400) {
        setState('offline', 'Camera Offline', 'The publisher disconnected before playback could start.');
        await releaseConnection();
        scheduleRetry(5000);
        return;
      }
      throw new Error('The secure WebRTC session could not be established.');
    }
    const locationHeader = response.headers.get('location');
    if (!locationHeader) throw new Error('The media server did not return a WebRTC session.');
    const sessionUrl = new URL(locationHeader, endpoint);
    if (sessionUrl.origin !== location.origin) throw new Error('The media server returned an invalid WebRTC session URL.');
    whepSessionUrl = sessionUrl.href;
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) {
    if (playbackRequested) {
      $('#player-error').textContent = error.message || 'Unable to connect to the camera.';
      $('#player-error').hidden = false;
      setState('reconnecting', 'Connection interrupted', 'Retrying the secure WebRTC connection.', true);
      await releaseConnection();
      scheduleRetry();
    }
  } finally {
    starting = false;
    if (playbackRequested) $('#stop-button').disabled = false;
  }
}

async function initialize() {
  try {
    const session = await api('/api/auth/session');
    if (!session.authenticated) return location.replace('/login');
    csrfToken = session.csrfToken;
    $('#account-name').textContent = session.user.username;
  } catch {
    return;
  }

  $('#start-button').addEventListener('click', () => {
    if (playbackRequested) return;
    playbackRequested = true;
    retryCount = 0;
    startPlayback();
  });
  $('#stop-button').addEventListener('click', async () => {
    playbackRequested = false;
    window.clearTimeout(retryTimer);
    retryTimer = null;
    await releaseConnection();
    setState('idle', 'Playback stopped', 'Start playback to connect to the front camera.');
  });
  $('#tap-to-play').addEventListener('click', async () => {
    try {
      await video.play();
      $('#tap-to-play').hidden = true;
      setState('live', 'Live', 'Connected to the front camera stream.');
    } catch {
      $('#player-error').textContent = 'Playback is blocked by the browser. Check site permissions and try again.';
      $('#player-error').hidden = false;
    }
  });
  $('#audio-button').addEventListener('click', () => {
    video.muted = !video.muted;
    $('#audio-button').title = video.muted ? 'Unmute video' : 'Mute video';
    $('#audio-button').setAttribute('aria-label', $('#audio-button').title);
    $('#audio-icon').textContent = video.muted ? '◖' : '◖̸';
  });
  $('#fullscreen-button').addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const fullscreen = Boolean(document.fullscreenElement);
    $('#fullscreen-button').title = fullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    $('#fullscreen-button').setAttribute('aria-label', $('#fullscreen-button').title);
  });
  $('#logout-button').addEventListener('click', async () => {
    playbackRequested = false;
    window.clearTimeout(retryTimer);
    await releaseConnection();
    await api('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
    }).catch(() => {});
    location.replace('/login');
  });

  $('#start-button').disabled = false;
  setState('idle', 'Playback stopped', 'Start playback to connect to the front camera.');
}

initialize();