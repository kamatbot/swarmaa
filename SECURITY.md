# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Swarmaa, please report it privately rather than opening a public issue:

- **Email:** [mayur@kamatbot.com](mailto:mayur@kamatbot.com)
- **GitHub Private Vulnerability Reporting:** Use [GitHub Security Advisories](https://github.com/kamatbot/swarmaa/security/advisories/new) on `github.com/kamatbot/swarmaa`.

Please include a clear description of the issue, affected files or endpoints, reproduction steps, and potential impact. We aim to acknowledge reports within 72 hours and coordinate fixes before public disclosure.

## Architecture and Trust Boundaries

For detailed documentation on how Swarmaa enforces tenant/scope isolation, OAuth grants, worker lease fencing, Seatbelt sandboxing, and webhook SSRF/HMAC verification—as well as operator responsibilities when self-hosting—read [docs/SECURITY.md](docs/SECURITY.md).

## Known Upstream Test Fixtures (Non-Credentials)

Automated secret scanners may flag the following files in the vendored upstream Reason Network snapshot:

- `vendor/reason-network/src/testdata/proof-forger.pk8`
- `vendor/reason-network/src/testdata/proof-signer.pk8`

These `.pk8` files are intentional, public unit-test fixtures from upstream `reason-machines/reason-network` (`src/proof.rs` tests) used to test cryptographic proof verification and forgery rejection. They are **not** live keys or service credentials, and `vendor/reason-network` is not compiled or executed by the Swarmaa service.
