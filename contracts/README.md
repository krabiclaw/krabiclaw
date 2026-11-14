# Contracts

These fixtures capture the JSON consumed by the web and iOS apps. The inbox list comes from `GET /api/messages`, and `thread.json` and `opening.json` capture cursor pages from `GET /api/messages/{id}`. Conversation details and suggestions still use the corresponding workspace guest thread actions. The contract test uses a fixed clock and IDs across Airbnb and direct booking fixtures. Run `yarn contracts` to check the committed output and `yarn contracts:write` to regenerate it after an intentional API change.
