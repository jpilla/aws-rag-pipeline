# express-api-docker

Setup commands:

npm install

npm install -g typescript


Build image and run app in container:

docker build -t express-api .

docker run -d -p 3000:3000 express-api
