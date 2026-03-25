FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY server.mjs .
COPY public/ public/
COPY sites/ sites/
EXPOSE 3000
CMD ["node", "server.mjs"]
