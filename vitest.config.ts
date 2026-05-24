import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Without this, vitest skips writing coverage reports when any test
      // fails — which makes Coverage Floor fail with "no coverage-summary.json
      // produced" on every PR that has a flaky test, even if 99% pass. The
      // workflow uses `|| true` to ignore vitest's exit code, but it can't
      // recover a file that was never written.
      reportOnFailure: true,
    },
  },
});
