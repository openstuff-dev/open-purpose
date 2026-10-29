# The OpenPurpose image, so the built-in export runs exactly as in the app, plus pg_dump and rclone.
ARG OPENPURPOSE_IMAGE_TAG=latest
FROM ghcr.io/openstuff-dev/open-purpose:${OPENPURPOSE_IMAGE_TAG}
USER root
# pg_dump must be at least as new as the server (Supabase runs Postgres 15 or 17).
RUN apk add --no-cache postgresql18-client rclone tzdata
COPY --chmod=755 backup.sh /usr/local/bin/backup
USER node
HEALTHCHECK NONE
ENTRYPOINT ["backup"]
CMD ["daily"]
