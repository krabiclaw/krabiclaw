# Discord

An organization connects Discord the way it connects Facebook: **Connect
Discord** is a Better Auth sign-in, and the owner then chooses a channel. Posts
are published there by the KrabiClaw bot, from the dashboard or MCP
`publish_post`. It requires the Growth plan.

## How it works

- Better Auth's Discord provider links the owner's Discord account with the
  `guilds` and `bot` scopes (`INTEGRATION_SCOPES.discord`). On Discord's consent
  screen the owner picks a server, and Discord adds the KrabiClaw bot to it
  with View Channel, Send Messages, Embed Links, Attach Files and Read Message
  History (`DISCORD_BOT_PERMISSIONS`).
- The Integrations → Discord leaf lists the text and announcement channels the
  bot can see in the servers that account manages. The organization stores
  only the chosen channel and the linked account, in `organization_integrations`.
  No organization holds a Discord token.
- The bot creates the message with the publication's nonce and
  `enforce_nonce`, so a repeated create returns the same message. Discord
  applies its own message and attachment limits, and its refusal is what the
  publication reports. `<@user-id>` in a post's text pings that member.
- A receipt's link opens only for members of that channel, so the public site
  does not list Discord.
- `reconcile_post_publication` resolves an unknown outcome from the bot's
  message id, which `list_channel_posts` shows.

## Configuration

KrabiClaw's Discord application is `1557308603734560778` in the Discord
Developer Portal (owner: paulchrisluke). Its OAuth2 redirects are
`https://krabiclaw.com/api/auth/callback/discord`,
`https://staging.krabiclaw.com/api/auth/callback/discord` and
`http://localhost:3000/api/auth/callback/discord`.

Worker secrets, in production and staging (and `.env` locally):
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`. Rotate the
client secret or bot token in the portal, then `wrangler secret put` it in
each environment.
