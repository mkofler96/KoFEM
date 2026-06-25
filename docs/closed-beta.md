# Closed beta (password-gated app + request-access waitlist)

KoFEM can run in two deploy modes, toggled by `update-prod.sh`:

| Mode | Command                      | `/app/` solver          | Landing CTA      |
| ---- | ---------------------------- | ----------------------- | ---------------- |
| live | `bash update-prod.sh`        | open to everyone        | "Start Solver"   |
| beta | `bash update-prod.sh --beta` | gated behind a password | "Request access" |

The mode is a **runtime** switch (env `KOFEM_MODE`), read by the pre-built web
image at container start — no rebuild needed to flip between live and beta.

## How beta works

```
landing "Request access" ──▶ POST /api/request-access ──▶ requests.jsonl   (you review)
visitor with a code      ──▶ /beta/ gate ──▶ POST /api/beta/login ──▶ cookie ──▶ /app/
nginx on every /app/ hit ──▶ auth_request ──▶ GET /api/beta/verify ──▶ 204 / 401→/beta/
```

- `/app/` is protected by nginx `auth_request` against the **kofem-access**
  service (a tiny zero-dependency Node container, built locally from `./access`,
  never published). It accepts the **master password** or any active
  **individual code**.
- The cookie value _is_ the code and is re-validated on every request, so
  **revoking a code locks that person out immediately**.
- Access requests from the landing form are appended to a file on a Docker
  volume; you approve them manually and email out codes yourself (no SMTP).

## First-time setup

1. Choose a master password and put it in `.env` next to `docker-compose.yaml`
   (gitignored):

   ```bash
   echo 'KOFEM_BETA_MASTER=choose-a-strong-password' >> .env
   ```

2. Start beta mode:

   ```bash
   bash update-prod.sh --beta
   ```

   It refuses to start without `KOFEM_BETA_MASTER` set.

## Day-to-day (manual approval)

```bash
# See who has requested access
docker compose exec kofem-access node admin.mjs requests

# Approve someone → prints a one-time code (email it to them yourself)
docker compose exec kofem-access node admin.mjs grant alice@example.com

# List who currently has an active code (codes are stored hashed, not shown)
docker compose exec kofem-access node admin.mjs list

# Kick someone out (by email or by the code) — effective on their next request
docker compose exec kofem-access node admin.mjs revoke alice@example.com
```

Testers go to `https://<your-domain>/beta/`, enter the master password or their
individual code, and land in the solver. The master always works; rotate it by
changing `.env` and re-running `bash update-prod.sh --beta`.

## Going (fully) live

```bash
bash update-prod.sh
```

This stops the gate service (the waitlist data on the volume is kept) and serves
`/app/` openly again.

## Data & storage

Both files live on the `kofem-access-data` Docker volume:

- `requests.jsonl` — one `{email, ts}` per access request (deduped).
- `codes.json` — `{sha256, email, createdAt, revoked}` per individual code. The
  plaintext code is shown **only once** at `grant` time.

The master password is read from the environment and never written to disk.
