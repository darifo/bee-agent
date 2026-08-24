import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // The integration suites share one PostgreSQL instance and reset it
    // with TRUNCATE, so parallel files would race each other's tables.
    fileParallelism: false,
  },
})
