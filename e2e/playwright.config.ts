import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: 'http://localhost:8787', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /admin\.spec/ },
  ],
  webServer: {
    command: './start-api.sh',
    url: 'http://localhost:8787',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
