/**
 * Colyseus Cloud Deployment Configuration.
 * See documentation: https://docs.colyseus.io/deployment/cloud
 */

module.exports = {
  apps : [{
    name: "colyseus-app",
    script: 'build/index.js',
    time: true,
    watch: false,
    // The default in-memory matchmaker is process-local. Running multiple forked
    // workers without a shared presence driver can route players to different
    // processes and break join-by-id/state synchronization.
    instances: 1,
    exec_mode: 'fork',
    wait_ready: true,
  }],
};
