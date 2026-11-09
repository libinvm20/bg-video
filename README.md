# Private Camera Streaming Server

A server-side platform for one authenticated Android front-camera stream. MediaMTX receives H.264 over encrypted RTSPS, Express manages users and viewer authorization, and browsers play the stream over WebRTC/WHEP through Caddy HTTPS. The Android application is not included.

## Architecture

```text
Android front camera -- RTSPS/TCP 8322 --> MediaMTX -- WebRTC/UDP 8189 --> Browser
										 \-- WHEP/HTTPS --> Caddy --> Browser
											 |
											 +-- HTTP auth --> Express --> SQLite
```

MediaMTX is pinned to `v1.21.3`; its HTTP authentication callback, WebRTC/WHEP endpoint, and API configuration are based on that release's documentation. Review those interfaces before changing the pinned version.

## Requirements

- Ubuntu 24.04 VPS with a public IPv4 address, 2 CPU cores, and 2 GB RAM or more.
- A domain name whose DNS points to the VPS. If an `AAAA` record exists, it must point to a working IPv6 address.
- Docker Engine with the Compose plugin, Certbot, and OpenSSL.
- An Android publisher that supports H.264 and RTSPS over TCP. If it only supports plaintext RTSP, use the WireGuard-only profile below.
- A trusted TLS certificate for the domain for both Caddy HTTPS and the MediaMTX RTSPS listener.

## Install Docker

Install Docker Engine and its Compose plugin from Docker's Ubuntu repository:

```sh
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
```

Run the following Docker commands as a user with Docker access, or prefix them with `sudo`.

## Configure DNS And Secrets

Create an `A` record for the chosen hostname pointing to the VPS IPv4 address. Add an `AAAA` record only when IPv6 connectivity and firewall rules are configured correctly.

From the project directory:

```sh
cp .env.example .env
openssl rand -hex 32
```

Edit `.env`. Set `DOMAIN` without a scheme, and use unique random values for `ADMIN_PASSWORD`, `CAMERA_PUBLISH_PASSWORD`, and `MEDIAMTX_API_PASSWORD`. The administrator password must be at least 12 characters. Hex output from `openssl rand -hex 32` is safe to paste as an environment value. Restrict the file:

```sh
chmod 600 .env
```

The administrator is created from `ADMIN_USERNAME` and `ADMIN_PASSWORD` only when the SQLite database has no users. Changing those environment values later does not change the stored password hash. Keep the camera and MediaMTX API passwords private as well.

## Issue The RTSPS Certificate

The default MediaMTX configuration requires TLS for RTSP and listens on port `8322`. Do not start it without the matching certificate and private key.

Ensure inbound TCP port 80 is available, then issue a trusted certificate. Caddy must not already be occupying port 80 during this standalone issuance:

```sh
sudo apt install -y certbot
set -a
. ./.env
set +a
sudo certbot certonly --standalone --agree-tos --non-interactive -m you@example.com -d "$DOMAIN"
sudo env DOMAIN="$DOMAIN" sh scripts/install-rtsp-certificate.sh
```

The helper copies the certificate chain and private key into the ignored `mediamtx/certs/` directory with restrictive key permissions. Caddy separately obtains and renews its HTTPS certificate automatically.

For renewals, install a Certbot deploy hook that runs the helper from this repository. For example, replace `/path/to/bg-video` with the absolute project path and the email/domain values used for issuance:

```sh
sudo certbot renew --dry-run
sudo tee /etc/letsencrypt/renewal-hooks/deploy/refresh-mediamtx-cert >/dev/null <<'EOF'
#!/bin/sh
DOMAIN=your.domain.example sh /path/to/bg-video/scripts/install-rtsp-certificate.sh
EOF
sudo chmod 700 /etc/letsencrypt/renewal-hooks/deploy/refresh-mediamtx-cert
```

The helper restarts MediaMTX after a successful certificate deployment. The hostname in `.env`, the certificate, and the RTSPS URL must match.

## Firewall

Allow only these public ports for the default deployment:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 8322/tcp
sudo ufw allow 8189/udp
sudo ufw enable
```

Port `8322/tcp` is authenticated RTSPS publishing. Port `8189/udp` carries encrypted WebRTC media. Ports `8554`, `8889`, `9997`, and `9998` are not published by the default Compose file. Do not expose MediaMTX's API or internal WebRTC HTTP listener publicly.

The host firewall and any VPS/cloud firewall must agree. WebRTC signaling goes through HTTPS on 443; the ICE media path needs UDP 8189. If clients cannot connect through direct ICE, configure a TURN service and set `WEBRTC_ICE_URL`, `WEBRTC_ICE_USERNAME`, and `WEBRTC_ICE_PASSWORD` in `.env`.

## Start Services

Validate configuration and launch the stack:

```sh
docker compose --env-file .env config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f
```

The Compose stack contains the Express backend, MediaMTX, and Caddy. SQLite, Caddy certificates/configuration, and the RTSPS certificate files persist outside the containers. Containers restart automatically. To restart without deleting data:

```sh
docker compose restart
```

Do not use `docker compose down -v` unless you intend to delete the database and Caddy's stored certificates.

## Connect The Android Publisher

The only configured camera path is `front`. Use:

```text
rtsps://YOUR_DOMAIN:8322/front
```

Set the Android publisher username to `camera` and its password to the value of `CAMERA_PUBLISH_PASSWORD` in `.env`. Select H.264 and RTSP-over-TCP/RTSPS. The RTSP authentication callback accepts publishing only for this account, the `front` path, and the RTSP protocol. It does not grant read or administration permissions.

RTSPS support in the existing Android app has not been confirmed. Verify that the client supports RTSP over TLS, Basic authentication inside TLS, and the VPS certificate chain. Never send these credentials over plaintext RTSP on an untrusted network.

### RTSP-Only Client Over WireGuard

If the publisher cannot use RTSPS, first establish a WireGuard tunnel between the phone and VPS. Set `VPN_SERVER_IP` in `.env` to the VPS's WireGuard interface address, then start with the VPN override:

```sh
docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d --build
```

This changes MediaMTX to plaintext RTSP but binds port `8554` only to `VPN_SERVER_IP`; the app must use the private tunnel address:

```text
rtsp://WIREGUARD_SERVER_IP:8554/front
```

Keep port 8554 unavailable on the public interface and restrict the WireGuard peer/subnet. Do not use this profile without a functioning private tunnel. To return to the RTSPS-only default, stop the stack and start it without the VPN override.

## Sign In And Watch

- Dashboard: `https://YOUR_DOMAIN`
- Login: `https://YOUR_DOMAIN/login`
- Live viewer: `https://YOUR_DOMAIN/live`

The dashboard reports publisher availability, stream uptime, active MediaMTX readers, backend container CPU/memory, network traffic, and health. Network and resource figures are measured inside the backend container, not across the entire VPS. The camera name is `Front Camera (Selfie Camera)`.

The live page performs a real WHEP negotiation against MediaMTX. The browser requests a short-lived, read-only viewer credential from Express; it is never given the permanent publisher password. MediaMTX calls Express for each authorized action and expires the WebRTC read session with its viewer token. Only the `front` path can be read. When the publisher is absent, the page displays `Camera Offline`; it does not substitute a placeholder feed. Multiple authenticated browser sessions can view concurrently.

## API And Data

Private APIs require a session cookie:

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET /api/camera/status`, `GET /api/camera/info`, `POST /api/camera/view-token`
- `POST /api/camera/view-session/end` for viewer cleanup
- `GET /api/server/status`, `GET /api/server/health`, `GET /api/server/stats`

Passwords are Argon2id hashes. Session IDs and viewer tokens are stored as SHA-256 hashes. Browser session cookies are HTTP-only, SameSite Strict, and Secure in production; state-changing browser requests use CSRF tokens. Login is rate-limited. MediaMTX API/auth ports are available only on private Docker networks.

SQLite is stored in the `camera_data` Docker volume. Tables include `users`, `sessions`, `stream_events`, and `viewer_sessions`, plus persisted camera connection state. Keep backups of the Docker volume and `.env` separately, with appropriate access controls.

## Operations

```sh
docker compose logs -f backend
docker compose logs -f mediamtx
docker compose logs -f caddy
docker compose restart backend
docker compose pull
docker compose up -d --build
```

To update MediaMTX, change the pinned image and verify the corresponding release's authentication, API, and WebRTC/WHEP documentation before deploying.

## Troubleshooting

- **Caddy does not obtain HTTPS:** confirm DNS A/AAAA records, inbound TCP 80/443, and that no other service occupies those ports.
- **RTSPS certificate error:** confirm the certificate includes `DOMAIN`, the Android client trusts its issuer, and the key/certificate files are readable in `mediamtx/certs/`; then restart MediaMTX and inspect its logs.
- **Publisher is rejected:** confirm the exact password, username `camera`, path `/front`, H.264, RTSPS/TCP, and that the client sends Basic credentials after the challenge.
- **Dashboard says `Camera Offline`:** check that the phone is publishing and inspect `docker compose logs -f mediamtx backend`. A disconnected publisher is intentionally shown as offline.
- **Viewer cannot connect:** confirm UDP 8189 is open through both host and provider firewalls, the domain resolves to the VPS public address, and `docker compose ps` reports services healthy. For restrictive client networks, configure TURN.
- **RTSP-only Android client:** use the WireGuard profile; do not expose port 8554 publicly.
- **Need to check the stack:** use `docker compose ps` and `docker compose logs -f`; the private `/api/server/health` endpoint requires login.

## Verification Boundaries

The repository includes backend integration tests for login, session/CSRF checks, publishing restrictions, viewer-token path restrictions, and revocation. A real Android device, valid public DNS, trusted certificates, VPS firewall rules, and browsers on external networks are required to verify publishing, public HTTPS, ICE/TURN connectivity, multi-viewer playback, and reconnection end to end.
