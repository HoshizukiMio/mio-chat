# Mio Chat

[English](README.md)

Mio Chat 是 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 的自托管分支。使用同一个账号登录不同设备，即可打开已保存的会话和附件。每个账号使用自己的 DeepSeek API Key。

## 本地启动

安装 Node.js 24 和 pnpm 12.11.2。将 `.env.example` 复制为 `.env`，运行下面的命令生成加密密钥，并将输出填入 `MIO_ENCRYPTION_KEY`。

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

在另一个终端执行 `pnpm invite`，然后打开 [http://localhost:3000](http://localhost:3000)，用生成的邀请码注册。在「设置 → 数据管理」中填写你的 DeepSeek API Key。

开发时可在一个终端运行 `pnpm start`，并将该进程的 `PUBLIC_ORIGIN` 设为 `http://localhost:8090`。在另一终端执行 `pnpm dev`，打开 [http://localhost:8090](http://localhost:8090)。Rspack 会把 `/api` 转发到本地 3000 端口。

## Docker Compose 与 HTTPS

在服务器把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 HTTPS 地址，例如 `https://chat.example.com`，并填入 `MIO_ENCRYPTION_KEY`。

```sh
docker compose up --build -d
docker compose exec mio-chat node server/invite.ts
```

应用在宿主机监听 `127.0.0.1:3000`。用 Caddy 或 Nginx 将域名的 HTTPS 流量转发至该地址。以下是 Caddy 配置示例。

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

使用 Nginx 时，关闭代理响应缓冲以实时传递 SSE，并让请求正文限制至少支持 65 MiB 的附件上传。以 `TRUST_PROXY` 指定应用直接连接的可信代理地址或网段，使登录限速按客户端来源计算。容器内的直接来源地址以实际网络配置为准。

## 注册与数据

| `REGISTRATION_MODE` | 注册方式 |
| --- | --- |
| `invite`（默认） | 输入部署者签发的一次性邀请码 |
| `open` | 直接注册 |
| `closed` | 已有用户登录，注册入口关闭 |

调整模式后重启服务。邀请码默认有效 7 天。通过 `pnpm invite 24` 或 `docker compose exec mio-chat node server/invite.ts 24` 可设为 24 小时。

- 迁移旧数据时，在原来的 chat-demo 页面使用「导出所有历史对话」，再登录 Mio Chat 导入 ZIP。导入会替换当前账号的历史和附件。ZIP 保留会话、分支和可用的图片原件，其他附件保留文件信息。
- 用户的 DeepSeek API Key 加密存放在 SQLite，由服务端在调用 DeepSeek 时使用。聊天、附件和语音内容在使用对应功能时会发送给 DeepSeek。修改密钥后，系统会在复用失效附件时重新上传原件。
- 对话和原件按账号保存。设备主题和语言保存在浏览器中，未发送的草稿存在当前页面内存。其他设备的保存冲突会先显示提示，当前页面的编辑会保留到用户确认重新加载。

## 备份和恢复

暂停服务后备份整个数据目录（本地默认 `./data`，Compose 为 `mio-data` 卷的 `/app/data`）。目录包含 SQLite 文件、可能存在的 WAL 文件和附件原件。另行保存同一份 `MIO_ENCRYPTION_KEY`。恢复时先停止服务，将数据还原到持久化目录、让运行账号拥有读写权限，再使用原加密密钥启动。

运行 `pnpm type`、`pnpm lint`、`pnpm build` 和 `pnpm test` 验证本地修改。项目沿用上游的 [MIT 许可证](LICENSE)。
