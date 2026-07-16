FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY server/parse-api.mjs ./server/parse-api.mjs

EXPOSE 8787
CMD ["node", "server/parse-api.mjs"]
