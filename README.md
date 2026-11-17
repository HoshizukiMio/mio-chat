# Mio Chat

[简体中文部署说明](README.zh-CN.md)

Mio Chat is a self-hosted fork of [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo). Sign in on another device to continue your conversations. Each account uses its own DeepSeek API Key.

## Run locally

Use Node.js 24 and pnpm 12.11.2. Copy `.env.example` to `.env` and set `MIO_ENCRYPTION_KEY` to the output of this command.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

In a second terminal, run `pnpm invite` and use the code to register at [http://localhost:3000](http://localhost:3000). Open Settings → Data and enter your DeepSeek API Key.

The [deployment guide](README.zh-CN.md) covers Docker Compose, HTTPS, registration modes, history migration, and backups. For development checks, run `pnpm type`, `pnpm lint`, and `pnpm test`.

Mio Chat and its upstream source use the [MIT license](LICENSE).
