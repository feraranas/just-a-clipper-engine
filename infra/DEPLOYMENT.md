# Deployment and operations

## Existing deployment

These are final configurations for an already provisioned Ubuntu 24.04 VPS, not a one-command installer. Do not apply TLS configs on a fresh host before obtaining their certificates. No commands in this document need to run merely to open the PR.

| Repository file | Installed path |
| --- | --- |
| media/nginx.conf | /etc/nginx/sites-available/audiograms-media |
| media/index.html | /srv/audiograms-media/public/templates/classic/v1/index.html |
| logs/nginx.conf | /etc/nginx/sites-available/audiograms-logs |
| logs/log-formats.conf | /etc/nginx/conf.d/audiograms-log-formats.conf |
| logs/media-access.conf | /etc/nginx/snippets/audiograms-media-access.conf |
| logs/goaccess-media.service | /etc/systemd/system/goaccess-media.service |
| logs/logrotate.conf | /etc/logrotate.d/audiograms-media |
| logs/renewal-hook.sh | /etc/letsencrypt/renewal-hooks/deploy/audiograms-logs-reload |

Both site files have symlinks in /etc/nginx/sites-enabled. Nginx's existing http block includes conf.d/*.conf and sites-enabled/*. Preserve other/default sites. The log formats must load before the media site.

## Initial provisioning prerequisites

Inspect `sudo ss -lntup`, `sudo ufw status verbose`, `sudo nft list ruleset`, running services and existing sites before changes. Use UFW for its managed firewall rules; do not edit nft directly. Preserve SSH. Permit IPv4 TCP 80/443 in both UFW and any attached Hetzner firewall. Existing UFW additions target 62.238.11.0 specifically.

Packages installed: nginx, certbot, python3-certbot-nginx, goaccess, apache2-utils. The last package provides htpasswd; Apache is not the web server. The original guarded installers remain on the VPS as historical deployment records and are intentionally omitted here: their hardcoded staging paths and bootstrap workflow are not update scripts.

Create an unprivileged system user/group goaccess-media. Directory ownership/modes:

- /var/log/audiograms-media: www-data:goaccess-media, 2750; access.log and requests.json.log: www-data:goaccess-media, 0640.
- /var/lib/goaccess-media: goaccess-media:www-data, 2750. Setgid makes new report files inherit www-data so Nginx can read them without giving the GoAccess process membership in that group.
- /etc/nginx/audiograms-logs.htpasswd: root:www-data, 0640.
- /srv/audiograms-media/public/templates/classic/v1: directories 0755, approved files 0644.

Create the password interactively with `sudo htpasswd -cB /etc/nginx/audiograms-logs.htpasswd media-admin`, then set its ownership/mode above. Use -c only for initial creation; it overwrites an existing password file. Never put the password in Git or shell arguments.

For logs first-time certificate issuance, enable logs/bootstrap.conf as the site, validate/reload Nginx, then run `sudo certbot certonly --webroot -w /var/lib/letsencrypt -d logs.ferarana.work --email YOUR_EMAIL --cert-name logs.ferarana.work`. Use the final logs/nginx.conf only after issuance and password setup. The media certificate was installed with `sudo certbot --nginx -d media.ferarana.work --redirect --email YOUR_EMAIL` using a preexisting HTTP media site; this export contains its final TLS result, not that bootstrap.

Install the renewal hook executable (0755). Enable certbot.timer and goaccess-media.service after installing their files and running systemctl daemon-reload. The timer is shared: preserve renewals for both hostnames.

## Updating configuration

From a reviewed artifact on the VPS, back up only affected installed files into a root-only timestamped directory outside Nginx include directories. Install selected files to the table's destinations with mode 0644 (renewal hook 0755). Do not overwrite unrelated sites, passwords, certs or public assets. Validate with `sudo nginx -t` before `sudo systemctl reload nginx`. For a service-unit change, run `sudo systemctl daemon-reload` and `sudo systemctl restart goaccess-media`. Repeat verification below. If validation fails, restore the affected files from that backup before reloading. Do not copy this directory into the public document root.

## Assets

Only approved neutral samples are published. MP4 and JPEG were transferred explicitly from the Mac into a private incoming directory before publication. The deployed MP4 is 1,246,575 bytes, SHA-256 e5908aedddefe6a99c6bacb3b47a01107e28e6695a6b27d380926fe3f8b44d1f; JPEG is 59,377 bytes, SHA-256 8866da18e491a04bc16bbde9d82e26a146c96419f8e17e74062f16c6063823f9. They are excluded from this source export.

For updates: stage explicit approved files outside the web root, verify approval/hashes, privately back up existing assets, install to temporary files in the target directory, then rename on the same filesystem. Assets do not require reload. Use a new version path and explicit Nginx locations for incompatible version changes.

## Verification

```sh
sudo nginx -t
systemctl status nginx goaccess-media --no-pager
systemctl is-enabled certbot.timer goaccess-media.service
sudo ss -lntp
curl -I https://media.ferarana.work/templates/classic/v1/
curl -I https://media.ferarana.work/templates/classic/v1/poster.jpg
curl -I https://media.ferarana.work/templates/classic/v1/demo.mp4
curl -sS -D - -H 'Range: bytes=0-1023' https://media.ferarana.work/templates/classic/v1/demo.mp4 -o /tmp/classic-range.bin
wc -c /tmp/classic-range.bin
curl -sS -D - -H 'Range: bytes=-1024' https://media.ferarana.work/templates/classic/v1/demo.mp4 -o /tmp/classic-tail.bin
curl -I https://logs.ferarana.work/
curl -I https://logs.ferarana.work/live
sudo certbot renew --cert-name logs.ferarana.work --dry-run
sudo logrotate --debug /etc/logrotate.d/audiograms-media
```

Expect media 200 with correct MIME types, ranges 206 with Content-Range and 1024 response bytes, both logs routes 401 without credentials, and GoAccess bound only to localhost. Use normal certificate verification, never -k. Immediate post-reload TLS checks can briefly hit old workers: retry before changing certificates. Browser verification: login as media-admin, confirm live counts change, verify poster/playback/seek on media preview. Local predeployment WebSocket proxy tests returned 101; actual authenticated browser rendering was confirmed by the user, with no credentials sent to this session.

Inspect records with `sudo tail -f /var/log/audiograms-media/requests.json.log`; inspect service errors with `sudo journalctl -u goaccess-media -n 40 --no-pager`. Rotate dashboard password with `sudo htpasswd -B /etc/nginx/audiograms-logs.htpasswd media-admin`.

## Retention and limitations

The summary is COMBINED with query/referrer/user-agent omitted. Detailed JSON logs request ID, IP, method, normalized path, status, bytes, duration and selected range/content headers. No bodies/cookies/authorization values are recorded. Request time measures total transfer time, not backend execution. GoAccess is an aggregate dashboard, not a full request/body inspector.

Logs rotate daily or at 20 MiB when logrotate checks, retain 14 rotations, compress with delaycompress, and restart GoAccess after reopening Nginx logs. This is not a hard size cap. Dashboard statistics reset on rotation/restart; retained files stay on disk. No persistent historical database or import of old shared logs is configured.

## Rollback

For a failed update restore only affected files from its backup, validate nginx -t, reload, and restart the dashboard service only if needed. Preserve later unrelated edits. To retire the dashboard: disable only its enabled-site symlink, validate/reload Nginx, then disable/stop goaccess-media.service. To revert media logging too, remove its snippet includes before archiving the snippet/log-format files and restore the media site from the pre-dashboard backup if appropriate. Keep logs private through retention. Remove only the logs DNS record and Certbot lineage after removing active references if retiring the hostname. Do not stop shared Nginx, reset UFW or remove the media certificate.
