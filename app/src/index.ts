import express, { Request, Response } from 'express';

console.log("Running from:", __dirname);
console.log("Loaded file:", __filename);

const app = express();
const port = process.env.PORT;

app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'hello world!' });
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
