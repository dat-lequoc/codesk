# Codesk workflow

## Always redeploy

After any change to this project that affects the desktop app, the gateway, or
`codeskd`, run the redeploy without asking:

```bash
npm run desktop:redeploy
```

The installed `/Applications/Codesk.app` runs a built binary, so source changes
and passing tests are invisible until the app is rebuilt and relaunched. Treat
the redeploy as part of finishing the task, not as a separate decision — do not
ask for permission, and do not stop at "you'll need to redeploy".

## Styling

New frontend work uses Tailwind utilities, not new rules in `src/styles.css`.
Preflight is deliberately off, and Tailwind utilities sit in a cascade layer that
loses to the unlayered rules in that stylesheet, so:

- Migrate an element by deleting its CSS rule, never by stacking utilities on it.
- Never mix a hand-written class and utilities on the same element.
- `border` needs `border-solid` beside it, because without Preflight the default
  border style is `none`.

See [docs/styling-migration.md](../../docs/styling-migration.md) for the phased
plan and the CSS audit command.
