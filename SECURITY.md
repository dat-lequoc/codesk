# Security policy

Codesk can launch coding agents and tool processes with the permissions of the execution host. Treat projects, provider credentials, SSH access, and daemon endpoints as sensitive.

## Trust model

The `codeskd` API can start processes and read files, so the port it listens on is not the credential. Every route except `/v1/health` requires a bearer token that the daemon writes to `<data dir>/token` at mode 0600; the gateway reads it from disk locally and over SSH for a remote host. The boundary this draws is the POSIX user: anyone who can read that file, or who already runs code as that user, has the daemon's authority. It is not a sandbox, and it does not defend against malicious code already running in the user's own session.

Requests that arrive with an `Origin` header are refused, so a page in the user's browser cannot reach the daemon even before authentication.

`codeskd` binaries are installed on a remote host by copying a local or peer binary over SSH. Installing from a URL is only allowed when `CODESK_DAEMON_RELEASE_BASE_URL` is configured, and only for artifacts under that prefix.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, contact the maintainer through the repository owner's GitHub profile and include only the minimum reproducible details.

Do not include API keys, SSH private keys, access tokens, or unredacted agent transcripts in a report.

## Supported versions

Until the first stable release, the `main` branch is the supported development line. Security fixes may not be backported to older commits or unreleased builds.
