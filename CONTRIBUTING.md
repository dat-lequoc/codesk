# Contributing to Codesk

Thanks for helping improve Codesk. Small, focused pull requests are easiest to review.

## Development setup

Install Node.js 22 or newer, a stable Rust toolchain, and the agent CLIs you want to exercise. Then run:

```bash
npm install
npm run dev
```

The desktop shell is available with `npm run desktop`. Remote execution uses the `codeskd` daemon; see the [README](./README.md) and [architecture](./ARCHITECTURE.md) for the local/remote boundary.

## Before opening a pull request

Run the checks relevant to your change:

```bash
npm run check
npm run build
cargo fmt --all -- --check
cargo test -p codeskd
```

Provider integration scripts may require the corresponding provider CLI and credentials, so they are not expected to run in every development environment.

Please avoid committing credentials, private transcripts, local screenshots, build output, or machine-specific paths. Keep provider-specific behavior behind an adapter and document user-visible limitations.

## Pull requests

Describe the user-visible change, include the checks you ran, and attach a screenshot or short reproduction when the change affects the desktop UI. If the change alters the daemon protocol or provider behavior, update the relevant documentation as well.
