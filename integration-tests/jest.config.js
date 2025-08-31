module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000, // 30 second timeout for integration tests
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};