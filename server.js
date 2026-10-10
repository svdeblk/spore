import { loadConfig, productionProblems } from './lib/config.js';
import { openDb, purgeExpired } from './lib/db.js';
import { createApp } from './lib/app.js';

const config = loadConfig();
const problems = productionProblems(config);
if (problems.length > 0) {
  console.error(`spore won't start in production until:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  process.exit(1);
}
const db = openDb(config.dbPath);
const app = createApp({ db, config });

setInterval(() => purgeExpired(db), 60 * 60 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`spore listening on ${config.host}:${config.port}`);
});

// finish open requests then close the db so its wal is checkpointed

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
