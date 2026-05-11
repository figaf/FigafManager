# Build context MUST be the workspace root (the figaf-installer/ directory),
# not apps/figaf-manager/ — we need access to packages/core and packages/ui.
#
#   docker build -f apps/figaf-manager/Dockerfile -t figaf-manager .
FROM node:20-slim

WORKDIR /app

# Workspace manifests — install with workspaces resolution intact
COPY package.json package-lock.json ./
COPY apps/figaf-manager/package.json    ./apps/figaf-manager/
COPY packages/core/package.json         ./packages/core/
COPY packages/ui/package.json           ./packages/ui/
COPY packages/deploy-templates/package.json ./packages/deploy-templates/

RUN npm install --omit=dev --workspaces --include-workspace-root

# App + shared sources
COPY apps/figaf-manager/cloud/      ./apps/figaf-manager/cloud/
COPY apps/figaf-manager/host.cloud.js ./apps/figaf-manager/
COPY apps/figaf-manager/bin/        ./apps/figaf-manager/bin/
COPY packages/core/                 ./packages/core/
COPY packages/ui/                   ./packages/ui/

RUN chmod +x apps/figaf-manager/bin/btp apps/figaf-manager/bin/cf 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/apps/figaf-manager
CMD ["node", "cloud/server.js"]
