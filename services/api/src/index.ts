import express, { Request, Response } from 'express';
import { makeHelloClient } from './helloClient';

const app = express();
const port = process.env.APPLICATION_PORT;
const hello = makeHelloClient();

app.get('/', (req: Request, res: Response) => {
  console.log(`Request received with method: ${req.method}`);
  res.json({ message: 'hello world!' });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/call-hello', async (_req, res) => {
  try {
    const result = await hello.health();
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'bad_gateway' });
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
