// Default lock state for dev and the initial image build. At container start,
// docker-entrypoint.d/40-kofem-lock.sh overwrites this file based on the
// KOFEM_LOCKED env var. See update-prod.sh (--locked).
window.KOFEM_LOCKED = false;
