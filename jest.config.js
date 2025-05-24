// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Look for test files in the tests/ directory
  roots: ['<rootDir>/tests'], 
  // Automatically clear mock calls and instances between every test
  clearMocks: true, 
  // Optional: Add a setup file if needed for global setup/teardown
  // Optional: Specify test file name pattern
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/?(*.)+(spec|test).+(ts|tsx|js)'
  ],
  transform: {
    '^.+\\.(ts|tsx)?$': ['ts-jest', { /*tsconfig: 'tsconfig.test.json' */ }]
  },
  // Optional: Module name mapper for aliases if you use them
  moduleNameMapper: {
    '^../src/(.*)$': '<rootDir>/src/$1'
  },
  // silent: true, // COMMENT OUT or REMOVE this line
  // detectOpenHandles: true, // Uncomment to help debug open handles
}; 