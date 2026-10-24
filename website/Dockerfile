FROM caddy:2.10.2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY . /srv
RUN rm -f /srv/Caddyfile /srv/Dockerfile /srv/.dockerignore /srv/check.py /srv/README.md /srv/purchase.test.cjs
