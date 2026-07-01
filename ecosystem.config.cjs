module.exports = {
  apps: [
    {
      name: 'qianfan-protocol-daemon',
      script: 'scripts/qianfan-protocol-daemon.js',
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        QIANFAN_PROTOCOL_DAEMON_PORT: '9324',
        QIANFAN_PROTOCOL_DAEMON_HOST: '0.0.0.0',
      },
    },
    {
      name: 'qianfan-protocol-config-agent',
      script: 'scripts/qianfan-protocol-config-agent.js',
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      restart_delay: 10000,
      env: {
        NODE_ENV: 'production',
        QIANFAN_PROTOCOL_SERVER_URL: 'http://127.0.0.1:9324',
      },
    },
  ],
};
