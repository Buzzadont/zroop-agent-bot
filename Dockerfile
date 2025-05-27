ARG NODE_VERSION=20

# ---- Base Stage ----
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /usr/src/app

# Install pnpm
RUN npm install -g pnpm

# ---- Dependencies Stage (for production image) ----
FROM base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- Build Stage (for building the app) ----
FROM base AS build
# Copy package.json and lock file first
COPY package.json pnpm-lock.yaml ./
# Install ALL dependencies (including devDependencies) for build
RUN pnpm install --frozen-lockfile 

# Copy the rest of the application code
COPY . .
# Run the build
RUN pnpm run build

# ---- Production Stage ----
FROM base AS production
ENV NODE_ENV=production

# Copy built artifacts from build stage
COPY --from=build /usr/src/app/dist ./dist
# Copy production dependencies from dependencies stage
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
# Copy frontend if it's served by Node.js and included in the build output directory
COPY --from=build /usr/src/app/frontend ./frontend 
COPY --from=build /usr/src/app/package.json ./package.json 
# Needed for PM2 and metadata

# Install PM2 globally
RUN npm install -g pm2

# Expose port (if your app listens on one, e.g., for API)
# Replace 3000 with your actual port if different
EXPOSE 3000

# Command to run the application using PM2
# This will be defined in ecosystem.config.js
CMD ["pm2-runtime", "ecosystem.config.js"] 