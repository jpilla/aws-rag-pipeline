export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  roots: ['<rootDir>'],
  verbose: true,
  clearMocks: true,
  collectCoverage: false,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@prisma/client$': '<rootDir>/tests/__mocks__/prisma.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: './tests/tsconfig.json',
    }],
  },
};
