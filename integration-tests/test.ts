import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Setting the base URL for axios makes it easier to make requests
const api = axios.create({
  baseURL: process.env.BASE_URL,
  timeout: 10000, // 10 second timeout
  // Let axios handle connection pooling internally
});

// No need for custom cleanup since axios manages its own connections

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

  describe('RAG Pipeline Integration', () => {
    it('should ingest Amazon reviews data and return relevant results', async () => {
      // 1. First, ingest the Amazon reviews data
      console.log('Ingesting Amazon reviews data...');
      try {
        const { stdout, stderr } = await execAsync(
          `node scripts/ingest_jsonl.js --file Amazon_Reviews_Short.jsonl --endpoint ${process.env.BASE_URL}/v1/ingest --batch 10 --concurrency 2`,
          { cwd: '/Users/jpilla/Documents/express-api-docker' }
        );
        console.log('Ingestion stdout:', stdout);
        if (stderr) console.log('Ingestion stderr:', stderr);
      } catch (error) {
        console.error('Ingestion failed:', error);
        throw error;
      }

      // 2. Wait a bit for the data to be processed
      console.log('Waiting for data processing...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 3. Query the endpoint with a question about mini farm animals
      console.log('Querying for mini farm animals...');
      const queryResponse = await api.post('/v1/query', {
        query: 'What do you know about mini farm animals?',
        limit: 5,
        threshold: 0.7
      });

      expect(queryResponse.status).toBe(200);
      expect(queryResponse.data).toHaveProperty('query');
      expect(queryResponse.data).toHaveProperty('answer');
      expect(queryResponse.data).toHaveProperty('context');
      expect(queryResponse.data).toHaveProperty('matches');

      // 4. Assert that we found embeddings and got a response (basic integration test)
      expect(queryResponse.data.matches).toBeGreaterThan(0);
      expect(queryResponse.data.context.length).toBeGreaterThan(0);
      
      // 5. Check that we didn't get the "no information" response
      expect(queryResponse.data.answer).not.toBe("I couldn't find any relevant information to answer your question.");
      
      // 6. Verify the context contains the expected keywords (proves ingestion worked)
      const contextText = queryResponse.data.context.map((chunk: any) => chunk.content).join(' ').toLowerCase();
      expect(contextText).toContain('mini farm animals');

      console.log('Query successful!');
      console.log('Answer:', queryResponse.data.answer);
      console.log('Matches found:', queryResponse.data.matches);
      console.log('Context chunks:', queryResponse.data.context.length);
    }, 60000); // 60 second timeout for this test
  });
});