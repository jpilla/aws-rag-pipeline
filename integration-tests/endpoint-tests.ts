import axios from 'axios';

// TypeScript interfaces for API responses
interface HealthResponse {
  status: string;
  service: string;
}

interface ReadyResponse {
  ready: boolean;
  via: string;
}

// Setting the base URL for axios makes it easier to make requests
const api = axios.create({
  baseURL: process.env.BASE_URL,
  timeout: 10000, // 10 second timeout
  // Let axios handle connection pooling internally
});

describe('API Endpoints', () => {
  describe('GET /', () => {
    it('should return 200 and the expected message', async () => {
      const response = await api.get('');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('message');
      expect(response.data.message).toBe('hello world!');
    });
  });

  describe('GET /healthz', () => {
    it('should return 200 and health status', async () => {
      const response = await api.get<HealthResponse>('/healthz');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data).toHaveProperty('service');
      expect(response.data.status).toBe('ok');
      expect(response.data.service).toBe('api');
    });
  });

  describe('GET /readyz', () => {
    it('should return 200 when dependencies are healthy', async () => {
      const response = await api.get<ReadyResponse>('/readyz');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('ready');
      expect(response.data).toHaveProperty('via');
      expect(response.data.ready).toBe(true);
      expect(typeof response.data.via).toBe('string');
      // Check that via field contains a valid service endpoint
      expect(response.data.via).toMatch(/^https?:\/\/.+/);
    });

    it('should respond within reasonable time', async () => {
      const startTime = Date.now();
      const response = await api.get<ReadyResponse>('/readyz');
      const endTime = Date.now();

      expect(response.status).toBe(200);
      expect(endTime - startTime).toBeLessThan(5000); // Should respond within 5 seconds
    });
  });
});
