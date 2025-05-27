module.exports = {
  apps : [
    {
      name      : "zroop-backend-server",
      script    : "./dist/backend/server.js",
      watch     : false,
      env_production: {
        NODE_ENV: "production"
      }
    },
    {
      name      : "zroop-telegram-bot",
      script    : "./dist/bot/bot.js",
      watch     : false,
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
}; 