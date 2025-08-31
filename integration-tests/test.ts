import axios from 'axios';
import http from 'http';
import https from 'https';

// Create HTTP agents with keep-alive enabled
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Setting the base URL for axios makes it easier to make requests
const api = axios.create({
  baseURL: process.env.BASE_URL,
  httpAgent,
  httpsAgent,
  timeout: 10000, // 10 second timeout
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
      const response = await api.get('/healthz');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data).toHaveProperty('service');
      expect(response.data.status).toBe('ok');
      expect(response.data.service).toBe('api');
    });
  });

  describe('GET /readyz', () => {
    it('should return 200 when dependencies are healthy', async () => {
      const response = await api.get('/readyz');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('ready');
      expect(response.data).toHaveProperty('via');
      expect(response.data.ready).toBe(true);
      expect(typeof response.data.via).toBe('string');
    });

    it('should return proper response structure', async () => {
      const response = await api.get('/readyz');
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('ready');
      expect(response.data).toHaveProperty('via');
      expect(typeof response.data.ready).toBe('boolean');
      expect(typeof response.data.via).toBe('string');
    });

    it('should respond within reasonable time', async () => {
      const startTime = Date.now();
      const response = await api.get('/readyz');
      const endTime = Date.now();

      expect(response.status).toBe(200);
      expect(endTime - startTime).toBeLessThan(5000); // Should respond within 5 seconds
    });
  });
});