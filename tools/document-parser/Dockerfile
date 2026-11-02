FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY bin/ ./bin/

ENV PORT=5001
ENV HOST=0.0.0.0
ENV DOCLING_SERVE_URL=http://docling-serve:5001
ENV MAX_BODY_BYTES=157286400
ENV CHUNK_MAX_CHARS=1500

EXPOSE 5001

HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:5001/health').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "bin/server.mjs"]
