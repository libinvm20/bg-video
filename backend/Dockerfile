FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/camera.sqlite
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY frontend /app/frontend
RUN mkdir -p /data && chown -R node:node /app/backend /app/frontend /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/_health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "start"]