FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install --production

COPY backend/ ./backend/
COPY frontend/ ./frontend/
RUN mkdir -p /app/data

EXPOSE 3456
CMD ["node", "backend/server.js"]
