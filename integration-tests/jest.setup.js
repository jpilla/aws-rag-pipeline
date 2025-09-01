// Global test setup for integration tests
const axios = require('axios');

// Increase timeout for all tests
jest.setTimeout(30000);

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Wait for services to be ready before running tests
beforeAll(async () => {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) {
    throw new Error('BASE_URL environment variable is required');
  }

  console.log(`🧪 Running integration tests against: ${baseURL}`);

  // Wait for API to be ready (with retries)
  let retries = 30;
  while (retries > 0) {
    try {
      await axios.get(`${baseURL}/healthz`, { timeout: 5000 });
      console.log('✅ API service is ready');
      break;
    } catch (error) {
      retries--;
      if (retries === 0) {
        throw new Error('API service failed to become ready within timeout');
      }
      if (retries % 5 === 0) { // Only log every 5th retry to reduce noise
        console.log(`⏳ Waiting for API service... (${retries} retries left)`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
});
