# Contributing

KrabiClaw is licensed under [AGPL-3.0](LICENSE). Before your first pull request
can be merged, sign the [Contributor License Agreement](https://cla-assistant.io/krabiclaw/krabiclaw);
the CLA check on the pull request links to it. You keep the copyright in your
contribution; the agreement lets KrabiClaw use, relicense and commercialize it.

- **Bugs and feature requests:** use the [issue forms](https://github.com/krabiclaw/krabiclaw/issues/new/choose).
- **Security:** see [SECURITY.md](SECURITY.md).
- **Code:** branch from `staging` and open the pull request against `staging`.
  Reference the issue (`#123`) in the title or body.

Before writing code, read [AGENTS.md](AGENTS.md) — it is the engineering standard
for people and coding agents alike — and set up with
[docs/local-development.md](docs/local-development.md). Testing follows
[docs/testing-strategy.md](docs/testing-strategy.md).

Yarn only. CI runs the full check suite and end-to-end tests on every pull request.
