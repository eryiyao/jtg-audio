# 听稿（jtg-audio）

给 yao 自己用的访谈 / 讲稿回听工具。上传音频，列出清单，用浏览器播放。刷新或关掉页面后，从上次停下的位置继续。

现在没有登录，也没有公开注册。进度先记在这台浏览器里。服务端留了一张进度表和接口，以后加账号时可以做跨设备同步。

## 本地运行

需要 Node.js 22.5 或更新版本（用内置的 `node:sqlite`，不用另外编译数据库）。

```bash
npm install
npm start
```

浏览器打开 http://127.0.0.1:3000

启动时如果看到 `ExperimentalWarning`，那是 Node 对内置 SQLite 的提示，可以忽略。

跑接口测试：

```bash
npm test
```

## 环境变量

也可以写成项目根目录的 `.env`，但程序不会自动读取 `.env`，需要自己导出，或由进程管理器注入。示例见 `.env.example`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。本机调试保持默认；要让局域网手机访问可设为 `0.0.0.0` |
| `DATA_DIR` | `./data` | 数据目录 |
| `UPLOAD_DIR` | `./uploads` | 音频文件目录 |
| `DATABASE_PATH` | `./data/jtg.sqlite` | SQLite 文件 |
| `MAX_UPLOAD_MB` | `200` | 单个文件上限（MB），最大按 2048 封顶 |

## 目录

```
src/server.js     Express 服务与接口
src/db.js         SQLite 表
public/           页面（HTML / CSS / JS）
data/             数据库，启动时自动创建，不进 git
uploads/          上传的音频，启动时自动创建，不进 git
test/             接口测试
```

页面只有一个地址：`/`。

## 能做什么

- 上传常见音频：mp3、m4a、mp4、wav、ogg、opus、aac、flac、webm
- 列表、播放、拖动进度
- 删除一条音频（文件和进度一起去掉）
- 刷新后续播

播放位置以浏览器 `localStorage` 为准，键是 `jtg-audio:pos:<音频 id>`。这条浏览器还有一个 `jtg-audio:client`，请求进度接口时当作 `clientKey`。

服务端表 `progress` 按 `(episode_id, client_key)` 存一份副本：

- `GET /api/progress/:id?clientKey=`
- `PUT /api/progress/:id`，JSON：`{ "positionSeconds": 12.3, "clientKey": "..." }`

恢复顺序：本机有记录就用本机；本机没有再读服务端。所以换一台手机现在不会自动续上，只是把口子留好。以后登录时，把 `client_key` 换成用户 id 即可。

一条音频真正播完后，进度会清成 0，下次从头听。中途暂停则停在暂停的位置，包括靠近结尾的时候。

其他接口：

- `GET /api/episodes`
- `POST /api/episodes`，表单字段 `audio`（文件）和可选的 `title`
- `PATCH /api/episodes/:id`，JSON：`{ "durationSeconds": 60 }`（播放器读到时长后会自己记一笔）
- `GET /api/episodes/:id/audio`（支持 `Range`，方便拖动）
- `DELETE /api/episodes/:id`

## 部署到阿里云

这段是给后续 Codex 或自己上手用的，这次不要真的部署。

这不是静态网站。上传、SQLite、续播接口都要一个常驻的 Node 进程。不要用 GitHub Pages，也不要只把 `public/` 丢到对象存储。

目标：阿里云轻量应用服务器（Linux），域名 `jimtogrow.com` 解析到这台机器。Node 只监听本机，由 Nginx 反向代理出去。

1. 安装 Node.js 22。`node -v` 至少是 22.5。
2. 代码放固定目录，例如 `/opt/jtg-audio`。在该目录执行 `npm install`。
3. 数据库和音频不要放仓库目录里，也不要放 `/tmp`。例如：
   - `DATA_DIR=/var/lib/jtg-audio/data`
   - `UPLOAD_DIR=/var/lib/jtg-audio/uploads`
   - `DATABASE_PATH=/var/lib/jtg-audio/data/jtg.sqlite`
4. 用 systemd 拉起进程，工作目录固定，环境变量写在 unit 里。升级代码时不要覆盖 `/var/lib/jtg-audio`。换机器或重装前先备份这个目录（sqlite 文件和 `uploads/` 都要）。
5. Nginx 把 `jimtogrow.com` 转到 `127.0.0.1:3000`，证书在 Nginx 上终结。`client_max_body_size` 要大于等于 `MAX_UPLOAD_MB`，否则大文件会被代理直接拒绝。
6. 安全组只开放 80 和 443。应用没有登录，任何人打开站点都能上传和收听。上线前用安全组、Nginx IP 限制，或 Nginx 基本认证收紧来源。等以后有登录再考虑对公网放开。
7. 音频拖动依赖 HTTP Range。反代时把 `Range` 原样转给 Node，不要在 Nginx 里把整个文件缓冲完再返回。

systemd 示例：

```ini
[Service]
WorkingDirectory=/opt/jtg-audio
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/jtg-audio/data
Environment=UPLOAD_DIR=/var/lib/jtg-audio/uploads
Environment=DATABASE_PATH=/var/lib/jtg-audio/data/jtg.sqlite
Environment=MAX_UPLOAD_MB=200
ExecStart=/usr/bin/node --experimental-sqlite /opt/jtg-audio/src/server.js
Restart=on-failure
```

`ExecStart` 里的 `node` 路径按机器上的实际位置改。

Nginx 示例（证书路径按实际证书改）：

```nginx
server {
  server_name jimtogrow.com;
  client_max_body_size 200m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
  }
}
```
