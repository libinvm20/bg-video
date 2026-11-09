#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "${script_directory}/.." && pwd)
cd "$project_directory"

if [ -z "${DOMAIN:-}" ] && [ -f .env ]; then
	DOMAIN=$(sed -n 's/^DOMAIN=//p' .env | head -n 1)
	export DOMAIN
fi

: "${DOMAIN:?Set DOMAIN in .env before installing the RTSP certificate}"
certificate_dir="/etc/letsencrypt/live/${DOMAIN}"

if [ ! -r "${certificate_dir}/fullchain.pem" ] || [ ! -r "${certificate_dir}/privkey.pem" ]; then
	printf 'A valid Certbot certificate for %s was not found.\n' "$DOMAIN" >&2
	exit 1
fi

install -d -m 700 mediamtx/certs
install -m 644 "${certificate_dir}/fullchain.pem" mediamtx/certs/server.crt
install -m 600 "${certificate_dir}/privkey.pem" mediamtx/certs/server.key

if docker compose ps --status running --services | grep -qx mediamtx; then
	docker compose restart mediamtx
fi