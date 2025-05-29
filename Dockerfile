ARG NODE_VERSION=20

# ---- Base: Just Node.js and user setup ----
FROM node:${NODE_VERSION}-slim AS base
USER node
WORKDIR /usr/src/app

# ---- Build Tools: Installs system deps and pnpm ----
FROM base AS build_tools
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    # curl and other tools might be needed if prebuilds are fetched
    # but for direct compilation, these are primary
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
USER node
# pnpm is now available here, along with build essentials

# ---- Production Dependencies: Install only prod node_modules, compile native ones ----
FROM build_tools AS prod_dependencies
# WORKDIR /usr/src/app is inherited
# USER node is inherited
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- Development Dependencies & Build Source: Install all deps and build the app ----
FROM build_tools AS dev_dependencies_and_build
# WORKDIR /usr/src/app is inherited
# USER node is inherited
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# ---- Production: Final lean image ----
FROM base AS production
ENV NODE_ENV=production
USER root
# Install only PM2 globally for runtime, or copy it if preferred and feasible.
# pnpm is not needed in the final image.
RUN npm install -g pm2
USER node
WORKDIR /usr/src/app

# Copy essential files for running the app
COPY --from=dev_dependencies_and_build /usr/src/app/package.json \
     --from=dev_dependencies_and_build /usr/src/app/ecosystem.config.js \
     ./

COPY --from=dev_dependencies_and_build /usr/src/app/dist ./dist/
COPY --from=dev_dependencies_and_build /usr/src/app/frontend ./frontend/
COPY --from=dev_dependencies_and_build /usr/src/app/public ./public/
COPY --from=prod_dependencies /usr/src/app/node_modules ./node_modules/

EXPOSE 3000
CMD ["pm2-runtime", "ecosystem.config.js"] 