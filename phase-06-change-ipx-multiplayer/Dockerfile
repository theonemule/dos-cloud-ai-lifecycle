FROM node:22-bookworm-slim

ENV NODE_ENV=production     PORT=8080     DOS_CLOUD_STATE_ROOT=/data     DOS_CLOUD_HTTPS=false     DOS_CLOUD_SECURE_COOKIES=true     DOS_CLOUD_LOG_TARGET=console     DOS_CLOUD_LOG_FORMAT=json     DOS_CLOUD_LOG_LEVEL=info

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund     && npm cache clean --force

COPY --chown=node:node . .

RUN mkdir -p /data/var /data/user-data/users     && chown -R node:node /data /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3   CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
