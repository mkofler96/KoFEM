// Default deploy mode for dev and the initial image build. At container start,
// docker-entrypoint.d/40-kofem-mode.sh overwrites this file based on the
// KOFEM_MODE env var (live | beta). See update-prod.sh (--beta).
window.KOFEM_MODE = "live";
