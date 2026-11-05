import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations'), JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef', STRIPE_WEBHOOK_SECRET: 'whsec_test', MASTER_EMAIL: 'owner@example.test' },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
}));
