# kofem-access: zero-dependency Node service backing the closed-beta gate and
# the "Request access" waitlist. Built locally by docker compose on the server
# (see update-prod.sh --beta) — not published to a registry.
FROM node:22-alpine

WORKDIR /app

COPY server.mjs admin.mjs ./

# Persisted to a named volume in docker-compose; created on boot if empty.
ENV KOFEM_DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
