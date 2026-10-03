# scour HTTP API (Firecrawl-compatible) in a container.
#   docker build -t scour .
#   docker run -e SCOUR_API_KEY=change-me -p 127.0.0.1:3002:3002 -v scour-data:/data scour
# The container listens on 0.0.0.0 inside, so an API key is required.
# Headless rendering (Playwright) is not included; static, native and served-
# Markdown tiers cover most pages.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production SCOUR_HOME=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY package.json README.md LICENSE ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3002
USER node
ENTRYPOINT ["node", "bin/scour.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3002"]
