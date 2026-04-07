// ecosystem.config.js — Configuración PM2 para producción
module.exports = {
  apps: [
    {
      name:        'wa-sender',
      script:      'server.js',
      cwd:         './backend',
      instances:   1,              // 1 instancia (WhatsApp no soporta clustering fácilmente)
      exec_mode:   'fork',
      watch:       false,          // nunca watch en producción
      max_memory_restart: '1G',    // reinicia si usa más de 1 GB

      // Variables de entorno para producción
      env_production: {
        NODE_ENV:   'production',
        PORT:       3000,
      },

      // Logs
      error_file: './logs/error.log',
      out_file:   './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:  true,

      // Reinicio automático en crashes
      autorestart:        true,
      restart_delay:      3000,
      max_restarts:       10,
      min_uptime:         '10s',

      // Graceful shutdown
      kill_timeout:       5000,
      listen_timeout:     10000,
    }
  ]
};
