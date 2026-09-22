FROM node:20-alpine
WORKDIR /app
COPY project/ ./project/
COPY run.js start.sh package.json ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "project/server/index.js"]
