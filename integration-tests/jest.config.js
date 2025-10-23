module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000, // 30 second timeout for integration tests
  verbose: true, // Set back to true to show individual test results
  silent: false,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  maxWorkers: 1,
  detectOpenHandles: false, // Changed from true to false to prevent open handle warnings
  testMatch: ['**/*.test.ts', '**/*.spec.ts', '**/endpoint-tests.ts', '**/rag-integration-tests.ts'],
};
