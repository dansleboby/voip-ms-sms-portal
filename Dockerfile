# syntax=docker/dockerfile:1

# The same package as for shared hosting (npm run build:cpanel), served by
# Apache with its .htaccess, as on a cPanel host: one server to maintain.

# Fully qualified, so Podman builds without asking which registry to use. Built on the
# machine that builds, whatever the image's platform: the package is the same for all.
FROM --platform=$BUILDPLATFORM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:cpanel

FROM docker.io/library/php:8.4-apache
# intl folds accents for search the way the browser does (é = e); the rest is in the base image.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libicu-dev; \
    docker-php-ext-install -j"$(nproc)" intl; \
    # Keeps the ICU library the extension links to, without its headers.
    apt-mark manual $(dpkg-query -W -f='${Package}\n' 'libicu[0-9]*'); \
    apt-get purge -y --auto-remove libicu-dev; \
    rm -rf /var/lib/apt/lists/*; \
    php -m | grep -qx intl
RUN set -eux; \
    a2enmod rewrite headers remoteip; \
    a2dissite 000-default; \
    # Open tabs ask for news every few seconds: an access log would mostly be that.
    a2disconf other-vhosts-access-log; \
    cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"; \
    groupadd --gid 1000 portal; \
    useradd --uid 1000 --gid portal --home-dir /data --no-create-home --shell /usr/sbin/nologin portal; \
    mkdir -p /data; \
    chown portal:portal /data
COPY docker/apache.conf /etc/apache2/sites-enabled/sms-portal.conf
COPY docker/ports.conf /etc/apache2/ports.conf
COPY docker/php.ini "$PHP_INI_DIR/conf.d/sms-portal.ini"
COPY --from=build /app/dist/cpanel/sms-portal /app/sms-portal
COPY --from=build /app/dist/cpanel/sms-portal-site /app/site
COPY docker-entrypoint.sh /usr/local/bin/sms-portal-entrypoint
ENV SMS_PORTAL_INSTALL=docker \
    SMS_PORTAL_DIR=/app/sms-portal \
    PORT=8080 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD php -r 'exit(@file_get_contents("http://127.0.0.1:" . (getenv("PORT") ?: 8080) . "/api/health") === false ? 1 : 0);'
# Starts as root only to give the data folder to PUID/PGID, which Apache's workers and the checks then run as.
ENTRYPOINT ["sms-portal-entrypoint"]
CMD ["apache2-foreground"]
