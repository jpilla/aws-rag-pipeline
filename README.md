# express-api-docker

Start app on port 3000:
```bash
make run-local
```

Run integration tests:
```bash
make integration-tests
```

One shot build image, upload to AWS ECR, and deploy AWS infra with CDK:
```bash
make deploy
```

Tear down local docker containers and AWS infra
```
make destroy
```

To use the VSCode debugger, start application with...
```bash
docker-compose down
IMAGE_TAG=$(git rev-parse --short HEAD) BUILD_TARGET=dev docker-compose up --build -d app
```
...then navigate to Run and Debug in VSCode and start the launch configuration called "Attach to Node.js in Docker (ts-node)"

When you're done, it's a good idea to run
```bash
BUILD_TARGET=dev docker-compose down
```