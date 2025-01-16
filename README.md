# express-api-docker

Start app on port 3000:
```bash
docker-compose up -d app
```

Run integration tests (starts app if not already running):
```bash
docker-compose up integration-tests
```

To use the VSCode debugger, start application with...
```bash
docker-compose down
BUILD_TARGET=dev docker-compose up --build -d app
```
...then navigate to Run and Debug in VSCode and start the launch configuration called "Attach to Node.js in Docker (ts-node)"

When you're done, it's a good idea to run
```bash
BUILD_TARGET=dev docker-compose down
```