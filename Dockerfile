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

# Apache and PHP from Debian's packages: they get the distribution's security updates, and
# nothing is compiled (the official PHP image keeps a compiler for that, twice the size).
FROM docker.io/library/debian:trixie-slim
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates apache2 libapache2-mod-php php-cli php-sqlite3 php-curl php-mbstring php-intl; \
    rm -rf /var/lib/apt/lists/*; \
    a2enmod rewrite headers remoteip; \
    a2dissite 000-default; \
    # Open tabs ask for news every few seconds: an access log would mostly be that.
    a2disconf other-vhosts-access-log; \
    # PUID/PGID, which the entrypoint passes on, instead of www-data.
    sed -ri 's/^export (APACHE_RUN_(USER|GROUP))=www-data$/export \1=${\1:-www-data}/' /etc/apache2/envvars; \
    grep -q 'APACHE_RUN_USER:-www-data' /etc/apache2/envvars; \
    # Errors go to the container's logs; the folders are open to a container started as another user.
    ln -sfT /dev/stderr /var/log/apache2/error.log; \
    for dir in /var/run/apache2 /var/lock/apache2 /var/log/apache2; do mkdir -p "$dir"; chmod 1777 "$dir"; done; \
    ln -s /etc/sms-portal/php.ini "/etc/php/$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')/apache2/conf.d/99-sms-portal.ini"; \
    groupadd --gid 1000 portal; \
    useradd --uid 1000 --gid portal --home-dir /data --no-create-home --shell /usr/sbin/nologin portal; \
    mkdir -p /data; \
    chown portal:portal /data
COPY docker/apache.conf /etc/apache2/sites-enabled/sms-portal.conf
COPY docker/ports.conf /etc/apache2/ports.conf
COPY docker/php.ini /etc/sms-portal/php.ini
COPY docker/apache2-foreground /usr/local/bin/apache2-foreground
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
