#!/usr/bin/env bash
# Deploy the newest dev image (ghcr.io/mkofler96/kofem-web:dev) to dev.kofem.org
# — but only an image this repository's CI built from the develop branch.
#
#   1. Pull :dev and pin the exact digest it resolved to.
#   2. Do nothing if that digest is already running.
#   3. Verify the digest's signed build provenance with `gh attestation verify`:
#      built by .github/workflows/ci.yml of mkofler96/KoFEM, from
#      refs/heads/develop, on a GitHub-hosted runner. An image pushed to GHCR in
#      any other way (a leaked token, a compromised registry account) has no
#      such attestation and is refused.
#   4. Start that digest — never the tag, which could move in between.
#
# Safe to run from a timer (deploy/systemd/): a run with nothing new is a no-op,
# a refused image leaves the running deployment untouched and exits non-zero.
#
# Needs: docker with compose, and the GitHub CLI (gh >= 2.55) logged in — a
# fine-grained token with no repository permissions is enough for a public repo.
set -euo pipefail

IMAGE="ghcr.io/mkofler96/kofem-web"
REPO="mkofler96/KoFEM"
WORKFLOW="${REPO}/.github/workflows/ci.yml"
CONTAINER="kofem-web-dev"

cd "$(dirname "${BASH_SOURCE[0]}")"

# One deploy at a time — a timer firing during a slow pull must not race it.
exec 9>"${TMPDIR:-/tmp}/kofem-deploy-dev.lock"
flock -n 9 || { echo "Another dev deploy is running — skipping."; exit 0; }

docker pull --quiet "${IMAGE}:dev" >/dev/null
DIGEST_REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${IMAGE}:dev" | grep -m1 "^${IMAGE}@sha256:" || true)"
if [ -z "$DIGEST_REF" ]; then
    echo "ERROR: ${IMAGE}:dev has no registry digest after the pull." >&2
    exit 1
fi

RUNNING="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$RUNNING" = "$DIGEST_REF" ]; then
    echo "dev.kofem.org already runs ${DIGEST_REF##*@} — nothing to do."
    exit 0
fi

echo "Verifying build provenance of ${DIGEST_REF}…"
if ! gh attestation verify "oci://${DIGEST_REF}" \
    --repo "$REPO" \
    --signer-workflow "$WORKFLOW" \
    --source-ref refs/heads/develop \
    --deny-self-hosted-runners; then
    echo "ERROR: ${DIGEST_REF} is not a CI build of ${REPO}@develop — NOT deploying." >&2
    echo "The running deployment was left as it is." >&2
    exit 1
fi

echo "Deploying ${DIGEST_REF}…"
KOFEM_DEV_IMAGE="$DIGEST_REF" docker compose up -d
docker image prune -f >/dev/null
echo "Done."
