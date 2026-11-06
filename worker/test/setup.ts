import { applyD1Migrations, env } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      empire_accounts: D1Database;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

await applyD1Migrations(env.empire_accounts, env.TEST_MIGRATIONS);
