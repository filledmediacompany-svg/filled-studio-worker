# Node + system tools (ffmpeg, yt-dlp, python for yt-dlp)
FROM node:20-bookworm-slim

# Install ffmpeg, python3 (for yt-dlp), curl, ca-certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    fonts-dejavu-core \
    fontconfig \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (latest)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --omit=dev=false
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
