module.exports = {
  apps: [
    {
      instances: 1,
      watch: false,
      name: 'filmes',
      autorestart: true,
      script: 'server.js',
    },
  ],
};
