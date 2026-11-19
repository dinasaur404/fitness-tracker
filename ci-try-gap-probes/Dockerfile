# Throwaway probe for Cloudflare CI (ci-try/gap-probes): can a runner run `docker build`?
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "console.log('docker build works, app:', require('./package.json').name)"
