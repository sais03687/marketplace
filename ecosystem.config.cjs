module.exports = {
  apps: [{
    name: "marketplace-provisioning",
    script: "src/index.ts",
    interpreter: "node",
    interpreter_args: "--import /opt/marketplace/node_modules/tsx/dist/esm/index.mjs",
    cwd: "/opt/marketplace/apps/provisioning-service",
    env_file: "/opt/marketplace/.env.prod",
    max_memory_restart: "512M",
    restart_delay: 5000,
    error_file: "/var/log/marketplace-provisioning.log",
    out_file: "/var/log/marketplace-provisioning.log",
    merge_logs: true
  }]
}
