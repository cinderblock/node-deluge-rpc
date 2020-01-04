// For a detailed explanation regarding each configuration property, visit:
// https://jestjs.io/docs/en/configuration.html

module.exports = {
  clearMocks: true,
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testRegex: '(/tests/[^/]+)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};
