# Use the official Node.js image as base
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Install TypeScript globally in the container
RUN npm install -g typescript

# Copy the rest of the application files
COPY index.ts tsconfig.json ./

# Compile TypeScript to JavaScript
RUN tsc

# Expose port 3000
EXPOSE 3000

# Command to run the application
CMD ["node", "dist/index.js"]