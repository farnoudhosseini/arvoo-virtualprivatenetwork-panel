# Arvoo fixes — OpenVPN TLS, i18n (FA), camouflage panel path

## OpenVPN Connect: Peer certificate verification failure

- `verify-x509-name` now uses explicit type: `verify-x509-name "CN" name`
- Client profiles no longer emit a bare `tls-crypt`/`tls-auth` line before the inline block
- `tls-auth` clients get `key-direction 1`
- Server certificate SAN includes the exact CN used by `verify-x509-name`
- Client certificates include `keyEncipherment` for broader TLS compatibility

**After deploy:** rebuild API, restart panel, re-download client `.ovpn` profiles.
Optionally redeploy the inbound so the server cert SAN is refreshed.

## Persian (FA) UI language

- `apps/web/src/lib/i18n/` — EN/FA dictionary + `I18nProvider`
- Sidebar, settings language toggle, RTL via `<html dir="rtl">`
- Switch language from the user menu (فارسی / English)

## Camouflage: fake site on 443, panel under secret path

- Public marketing site at `/` (`site/` → `/var/www/arvoo-site`)
- Admin UI at `ARVOO_PANEL_PATH` (default `/panel`)
- API remains at `/api/`
- Set before install/build:
  ```bash
  export ARVOO_PANEL_PATH=/panel
  export VITE_BASE=/panel/
  npm run build -w apps/web
  ```

## Installer

- `ARVOO_PANEL_PATH` supported; nginx snippet placeholders substituted at install time

## References (design only, not copied)

- https://github.com/Sir-MmD/vpn-ui — multi-protocol / GRE carrier patterns
- https://github.com/DrSaeedHub/Tunnel-Panel — GRE plan/preview/verify, secret web path
