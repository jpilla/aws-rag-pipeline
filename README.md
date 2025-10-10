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

To use the VSCode debugger:
1. Start the application in debug mode: `make run-debug`
2. Navigate to Run and Debug in VSCode and start "Attach to API in Docker"

The debugger will attach to the production container - no special debug setup needed!

For normal development (no debugging), just use:
```bash
make run-local
```