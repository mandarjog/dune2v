# Dune II browser skirmish — static client + WebSocket host
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.html ./
COPY css ./css
COPY js ./js
COPY maps ./maps
COPY dist ./dist
COPY server ./server
COPY tools ./tools
COPY README.md DESIGN.md ./

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV RECORDINGS_DIR=/data/recordings

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Root so Fly volume at /data is writable; app binds 8080 only.
USER root
CMD ["sh", "-c", "mkdir -p \"${RECORDINGS_DIR:-/data/recordings}\" && exec node server/index.js"]
