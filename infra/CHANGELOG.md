# Deployment record

- Inspected services, ports, DNS and UFW/nftables before deployment; only SSH was listening initially.
- Published the preexisting approved Classic V1 MP4/JPEG and a static preview; no media was generated and no app repository was cloned.
- Preserved existing SSH/source-specific HTTPS rules and default Nginx site; added public IPv4 HTTP/HTTPS.
- Fixed preview HTTP 500 by replacing a file alias with try_files in its exact location.
- Diagnosed Certbot UTF-8 failure as terminal email-input decoding; passed email explicitly on later issuance.
- Verified public media HTTPS, MIME types and beginning/suffix byte ranges (206, 1024 bytes).
- Added separate sanitized media summary/JSON logs, protected GoAccess dashboard and authenticated WebSocket proxy.
- Tested unauthenticated 401, authenticated local dashboard 200 and proxy 101, JSON validity and query/cookie/authorization exclusion in an isolated Nginx instance.
- Verified actual TLS for logs hostname, 401 on both protected routes, unprivileged GoAccess service and localhost-only 7890 listener.
- Initial immediate post-reload check saw a default certificate; subsequent verified checks succeeded. Installer check was updated with retries.
- User confirmed dashboard works and supplied a successful certificate-renewal dry-run.
- Snapshot taken for PR preparation on the Mac. No PR has been created or merged from this VPS.

Original deployment backups remain private under /var/backups/audiograms-media and /var/backups/audiograms-logs. Passwords, keys, logs and runtime outputs are excluded from this export.
