# Deployment

Two sites run from the same image, `ghcr.io/mkofler96/kofem-web`, on the VPS:

| Site          | Branch    | Image tag | Deployed                                         |
| ------------- | --------- | --------- | ------------------------------------------------ |
| kofem.org     | `main`    | `:latest` | by hand (`update-prod.sh`), after a promotion PR |
| dev.kofem.org | `develop` | `:dev`    | automatically, by `dev/deploy-dev.sh` on a timer |

CI pushes an image only from those two branches, and attaches signed build
provenance to every image it pushes (`actions/attest-build-provenance`, GitHub
OIDC). The container's channel is set at start, not at build:
`KOFEM_CHANNEL=dev` adds `noindex` to every page, a deny-all `robots.txt` and a
**DEV** badge in the app (`web/docker-entrypoint.d/30-kofem-channel.sh`).

## Why the dev deploy verifies before it runs

An automatically deployed image is only as trustworthy as everything that can
put an image under its tag. `deploy-dev.sh` therefore deploys only an image
whose provenance says it was built by this repository's `ci.yml` from
`refs/heads/develop` on a GitHub-hosted runner, and it runs that exact digest —
an image pushed to GHCR any other way is refused, and the running site is left
alone. (Watchtower cannot check provenance, and needs the Docker socket, which is
root on the host — hence a script on a timer instead.)

The other layers:

- **Cloudflare Access** in front of dev.kofem.org, so a bad dev build never
  reaches the public.
- **Isolation**: the dev container runs on its own network, shared only with the
  tunnel, with all capabilities dropped but the three nginx needs,
  `no-new-privileges` and memory/CPU/PID limits (`dev/docker-compose.yml`).
- **Pinned supply chain**: base images by digest, Bun by version, third-party
  actions by commit; Dependabot proposes the bumps as PRs.
- **Branch rulesets** on `develop` and `main` (PRs only, required checks, no
  force-push or deletion).

## One-time setup on the VPS

1. Copy `deploy/dev/` to the VPS, e.g. `~/KoFEM-Private/dev/`.
2. Create the dev network and attach the Cloudflare tunnel container to it:
   ```bash
   docker network create kofem-dev
   docker network connect kofem-dev <cloudflared container>
   ```
   (or add `kofem-dev` as an external network to the tunnel's own compose file,
   so it survives a re-create).
3. In the tunnel configuration, add the public hostname
   `dev.kofem.org → http://kofem-web-dev:10000`.
4. In Cloudflare Zero Trust, add an Access application for `dev.kofem.org`
   (e.g. one-time PIN to your e-mail).
5. Install the GitHub CLI (≥ 2.55) and log in as the deploying user:
   `gh auth login` — a fine-grained token with no repository permissions is
   enough, the repository is public.
6. First deploy by hand, then enable the timer:
   ```bash
   ~/KoFEM-Private/dev/deploy-dev.sh
   sudo cp systemd/kofem-dev-deploy.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now kofem-dev-deploy.timer
   ```
   Adjust `User=` and `ExecStart=` in the service first. Failed checks show in
   `systemctl status kofem-dev-deploy` and `journalctl -u kofem-dev-deploy`.

## Production

Unchanged: `update-prod.sh` pulls `:latest` when you run it. To give it the same
guarantee, verify before starting the new image:

```bash
docker compose pull
DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/mkofler96/kofem-web:latest)
gh attestation verify "oci://$DIGEST" --repo mkofler96/KoFEM \
  --signer-workflow mkofler96/KoFEM/.github/workflows/ci.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
docker compose up -d
```

## Branches

Feature PRs target `develop`. When dev.kofem.org looks right, a PR from
`develop` to `main` promotes it — usually the release PR (`Release vX.Y.Z`, see
the release skill).
