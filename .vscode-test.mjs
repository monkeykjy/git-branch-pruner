import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  ...(process.env.BRANCH_PRUNER_VSCODE_PATH ? { useInstallation: { fromPath: process.env.BRANCH_PRUNER_VSCODE_PATH } } : {}),
  ...(process.env.BRANCH_PRUNER_TEST_WORKSPACE ? { workspaceFolder: process.env.BRANCH_PRUNER_TEST_WORKSPACE } : {}),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  files: 'out/src/test/integration/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
