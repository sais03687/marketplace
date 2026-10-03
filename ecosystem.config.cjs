module.exports = {
  apps: [{
    name: "marketplace-provisioning",
    script: "src/index.ts",
    interpreter: "node",
    interpreter_args: "--import /opt/marketplace/node_modules/tsx/dist/esm/index.mjs",
    cwd: "/opt/marketplace/apps/provisioning-service",
    // The service reads /opt/marketplace/.env.prod itself at startup
    // (src/load-env.ts). pm2 has no env_file option — that key sat here looking
    // like it loaded the file and was silently ignored, so the process only ever
    // had whatever env the shell that started pm2 happened to hold. On
    // 2026-10-03 that meant LLM_BROKER_ENABLED was missing in production and
    // agents would have been handed the real model key. Do not reintroduce it;
    // ENV_FILE overrides the path if one is ever needed.
    max_memory_restart: "512M",
    restart_delay: 5000,
    error_file: "/var/log/marketplace-provisioning.log",
    out_file: "/var/log/marketplace-provisioning.log",
    merge_logs: true
  }]
}
