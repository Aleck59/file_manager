// Конфигурация PM2. Запуск: pm2 start ecosystem.config.cjs
// Рассчитано на VDS с малым объёмом ОЗУ: один процесс, жёсткие лимиты памяти.
module.exports = {
  apps: [
    {
      name: 'file-manager',
      script: 'src/server.js',
      cwd: __dirname,
      exec_mode: 'fork', // cluster не нужен: сервер только подписывает ссылки
      instances: 1,
      node_args: '--max-old-space-size=96 --max-semi-space-size=2',
      max_memory_restart: '160M',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      time: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
    },
  ],
};
