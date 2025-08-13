import express, { Request, Response } from 'express';

const app = express();
const port = process.env.APPLICATION_PORT;

app.get('/', (req: Request, res: Response) => {
  console.log(`Request received with method: ${req.method}`);
  res.json({ message: 'hello world!' });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
