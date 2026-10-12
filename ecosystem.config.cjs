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
      // Экономия ОЗУ: интерпретатор без JIT (~-15 МБ) и компактные лимиты кучи V8.
      // Для этого приложения скорость не меняется: время уходит на сеть, а не на JS.
      node_args: '--jitless --no-expose-wasm --optimize-for-size --max-old-space-size=64 --max-semi-space-size=1',
      max_memory_restart: '120M',
      env: {
        NODE_ENV: 'production',
        // glibc: сразу возвращать системе освобождённую память. Без этого 16 МБ, которые
        // берёт scrypt при каждом входе, оседают в куче процесса: 60 МБ → 120+ МБ.
        MALLOC_ARENA_MAX: '2',
        MALLOC_TRIM_THRESHOLD_: '131072',
      },
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
