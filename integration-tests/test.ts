import axios from 'axios';

// Setting the base URL for axios makes it easier to make requests
const api = axios.create({
  baseURL: process.env.BASE_URL,
});

describe('GET', () => {
  it('should return 200 and the expected message', async () => {
    const response = await api.get('');
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('message');
    expect(response.data.message).toBe('hello world!');
  });
});