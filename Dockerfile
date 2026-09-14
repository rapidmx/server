FROM node:lts-trixie-slim AS builder

# Set the working directory to /app
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . ./

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN echo Building as $NODE_ENV
ENV MONGOMS_DISABLE_POSTINSTALL=1
ENV REDISMS_DISABLE_POSTINSTALL=true
# Install any needed packages specified in requirements.txt
RUN apt update && apt upgrade -y
RUN corepack enable
RUN yarn install --immutable
RUN yarn build

FROM node:lts-trixie-slim AS runner
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/yarn.lock /app/.yarnrc.yml /app/tsconfig.json /app/RELEASE_NOTES.md ./
COPY --from=builder --chown=node:node /app/.yarn/releases ./.yarn/releases
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/scripts ./scripts
RUN chmod +x /app/scripts/*
# Add curl for health check, and msmtp as the sendmail(1) implementation PostfixSendmailTransport shells
# out to for outbound mail (see mail:transport:sendmail:path and scripts/docker-entrypoint.sh, which
# writes its config at container start to relay through the deployment's Postfix container).
RUN apt-get update && apt-get upgrade -f -y && apt-get install curl msmtp msmtp-mta -y
RUN ln -sf /usr/bin/msmtp /usr/sbin/sendmail
RUN npm install --global nodemon
RUN corepack enable

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN echo Running as $NODE_ENV

# Make port 3000 available to the world outside this container
EXPOSE 3000
# Make port 9229 available to the world for debugging
EXPOSE 9229

# Define environment variable
ENV PORT=3000
ENV HOME=/home/node

# /app itself is still root-owned at this point - the COPY --chown steps above only chown the files/dirs
# they copy, not their parent - and neither /app/data (LocalFsBlobStore's root, mail:blob:local:root) nor
# /var/lib/rspamd/dkim (FsDkimKeyProvider's mail:dkim:key_dir) exist in the image at all, so a fresh
# docker-compose/Helm volume mounted at either path would otherwise be created root-owned on first use.
# Without this, the `node` user (below) can't write into any of them at runtime.
# /app/plugins is where the plugin host (src/plugins/PluginHost.ts) npm-installs this deployment's plugins at startup -
# it must sit under /app so a plugin resolves the server's own copies of its shared peer packages.
RUN mkdir -p /app/data /app/plugins /var/lib/rspamd/dkim && chown node:node /app /app/data /app/plugins /var/lib/rspamd/dkim

USER node

# Set a healthcheck to ensure the service is always alive
HEALTHCHECK --interval=10s --timeout=60s --start-period=15s --retries=3 CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
# Run app.js when the container launches
CMD ["node", "dist/src/server.js"]