# Audiograms VPS infrastructure

Reviewed export of the deployed static media host and protected traffic dashboard. The VPS runs Nginx, Certbot and GoAccess; no application repository or MCP backend is deployed there. Source snapshot taken 2026-10-25 UTC. This directory contains configuration and documentation only: no private keys, password files, Certbot account data, logs, generated dashboard, media binaries, job outputs or backups.

## Layout

- media/nginx.conf: final deployed HTTPS media configuration, including logging. Not the original HTTP-only template.
- media/index.html: neutral Classic V1 preview.
- logs/nginx.conf: final dashboard HTTPS configuration.
- logs/bootstrap.conf: HTTP ACME bootstrap for first-time provisioning only.
- logs/log-formats.conf and media-access.conf: selected metadata and timings, no bodies.
- logs/goaccess-media.service and logrotate.conf: service isolation and retention.
- DEPLOYMENT.md: installation prerequisites, deployment, verification and rollback.
- CHANGELOG.md: deployment history and verification evidence.

Cloudflare DNS-only A records media.ferarana.work and logs.ferarana.work point to 62.238.11.0. TCP 80 and 443 are public over IPv4. GoAccess is reachable only through Nginx at 127.0.0.1:7890. Existing SSH and source-specific HTTPS rules were preserved. Do not publish AAAA without separate IPv6 firewall/reachability verification.

Keep runtime credentials and media approval separate from source control. Existing error logs can contain request information even though the new access formats omit query strings. Browser/OS/referrer panels are intentionally uninformative because those fields are omitted. For future changes, review a PR then transfer only the required files to the host.
