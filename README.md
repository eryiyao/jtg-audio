# JTG Audio

给 yao 自己用的文稿音频回听工具。上传音频，列出清单，用浏览器播放。电脑和手机共用云端进度，打开同一条音频后点击播放继续。

应用没有多用户账号系统或公开注册，正式站点通过 HTTPS 访问口令保护。进入这个私人音频库的设备共用一份播放进度。

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
- 列表、播放、拖动进度、前后跳转 15 秒、倍速收听
- 显示音频总占用空间；点击“添加音频”打开上传窗口
- 删除一条音频（文件和进度一起去掉）
- 刷新及跨设备续听，自动打开最近有进度的音频
- 睡眠定时：10、20、30 或 60 分钟后暂停，保留当前进度

界面只保留音频列表、添加按钮与播放器，使用暖白、橙色视觉。手机布局支持长标题和文件名换行，播放器与上传窗口按屏幕宽度收缩，避免整页横向溢出；保留进度条横向拖动和浏览器缩放。

播放位置以服务端 `shared_progress` 为准，浏览器 `localStorage` 保留本机缓存和待重试的写入。播放中每约 2–3 秒同步，暂停、切换音频和退到后台时立即提交；打开音频、刷新或回到暂停的页面时重新读取云端位置。

- `GET /api/shared-progress/:id`：读取共享进度。
- `POST /api/shared-progress/:id/session`：显式播放或拖动时取得新的播放会话；默认从云端位置继续，显式拖动使用指定位置。
- `PUT /api/shared-progress/:id`：携带 `sessionId`、递增 `sequence` 和 `positionSeconds` 保存。旧会话返回 409，乱序旧序号不改变当前位置。

新设备接着播放后，旧设备的下一次保存会被拒绝并暂停，避免互相覆盖。只是打开或关闭未播放的页面不会取得写入权。网络中断时，已有会话的进度暂存本机并在网络恢复后重试；若另一台设备已经接手，旧的离线记录会被丢弃，保留云端新进度。首次开始播放需要成功取得云端会话；失败会提示重试。

旧版 `progress` 表和 `/api/progress/:id` 接口保留。尚未建立共享进度的音频，会读取旧表中更新时间最近的记录；首次播放后使用共享记录，旧版页面再写入也不会覆盖它。升级后电脑和手机都需刷新一次页面。

一条音频真正播完后，进度会清成 0，下次从头听。中途暂停则停在暂停的位置，包括靠近结尾的时候。

播放器底部的“睡眠定时”可设置、修改或取消倒计时。从选择时刻按实际时间计算，暂停、倍速、拖动及切换音频不会重置它。倒计时仅对当前页面生效，同一标签页刷新会恢复截止时间；退出登录或删除正在选中的音频时取消。定时暂停后，可直接点击播放继续。

定时使用截止时间校验，普通定时回调、音频进度更新、页面恢复及开始播放时都会检查。手机浏览器可能延迟后台脚本执行，锁屏时的准确性需要在实际设备上验证；桌面模拟与测试时钟不能替代真机测试。

其他接口：

- `GET /api/episodes`
- `POST /api/episodes`，表单字段 `audio`（文件）和可选的 `title`
- `PATCH /api/episodes/:id`，JSON：`{ "durationSeconds": 60 }`（播放器读到时长后会自己记一笔）
- `GET /api/episodes/:id/audio`（支持 `Range`，方便拖动）
- `DELETE /api/episodes/:id`

## 阿里云部署与更新

独立地址：`https://audio.jimtogrow.com`。博客和库存系统保持原样。

- 代码：`/opt/jtg-audio`，跟随 GitHub `main`。
- 服务：独立 `systemd` 服务 `jtg-audio`，开机启动，仅监听 `127.0.0.1:4300`。
- 数据库：`/var/lib/jtg-audio/data/jtg.sqlite`。
- 音频：`/var/lib/jtg-audio/uploads/`。
- Nginx：`/etc/nginx/conf.d/jtg-audio.conf`。
- 私人访问：HTTPS 网页密码登录；沿用 `/etc/nginx/jtg-audio.htpasswd` 中的 SHA-512 crypt 散列。systemd 通过 `LoadCredential` 只读提供给本服务，不复制进仓库，也不扩大原文件权限。
- 登录记录：默认记住当前设备 30 天，固定有效期；取消勾选使用浏览器会话 Cookie，服务器最多接受 12 小时。数据库只存随机登录令牌的 SHA-256 摘要，普通更新/重启不会清除记录；退出只撤销当前设备。
- Cookie 仅限当前主机，带 `Secure`、`HttpOnly`、`SameSite=Lax`；写请求检查专用请求头、Origin 和 Fetch Metadata。登录按来源限速，失败记录跨重启保留。
- 单个上传上限 200 MB，Nginx 预留表单开销为 210 MB。

### 日常更新

本地修改 → `npm test` 和页面检查 → 提交推送 GitHub `main` → 服务器执行：

```bash
cd /opt/jtg-audio
./update.sh
```

脚本要求干净的 main 分支，只做快进拉取、安装锁定依赖、测试、重启本服务和健康检查。不会重置口令、删除音频或修改同机其他服务。配置文件变更需单独审核并应用，普通更新不复制 Nginx/systemd 配置。

更新后核对线上版本、认证、播放与续听。发生故障时查看 `sudo journalctl -u jtg-audio`；回退到上一已验证提交后重新安装依赖并重启本服务，不能回退或清空数据目录。

### 首次安装

使用已安装的 Node 22.5+、OpenSSL 3、Nginx、certbot 及支持 `LoadCredential` 的 systemd。确认 `/usr/bin/node` 是合适的版本，端口 4300 空闲。

1. 将仓库 main 克隆到 `/opt/jtg-audio`，运行 `npm ci --omit=dev` 和 `npm test`。
2. 建立无交互登录权限的专用系统用户 `jtg-audio`；数据目录属于该用户，ACME 目录供 Nginx 读取。
3. 准备独立密码文件（SHA-512 crypt，推荐 100000 轮）；安装 `deploy/jtg-audio.service`，`systemctl daemon-reload` 后启用并启动。生产环境缺少密码文件或 HTTPS 配置会拒绝启动。
4. 添加 `audio` 的 A 记录，指向现有服务器。
5. 初次只安装 `deploy/nginx-http.conf` 到本工具独立配置文件，测试 Nginx 后 reload；该配置仅提供证书验证，不暴露应用。
6. `certbot certonly --webroot -w /var/lib/jtg-audio/acme -d audio.jimtogrow.com` 获取证书；沿用服务器已有 certbot 账户与续期任务。
7. 密码不得出现在命令参数、日志或 GitHub 中。更新密码文件后重启本服务以刷新凭据，旧登录记录随密码版本变化失效。
8. 先确认应用启动并保护私人接口，再安装 `deploy/nginx.conf`，`nginx -t` 通过后 reload。匿名首页跳到 `/login`；登录页及必要样式公开，私人接口/音频仍返回 401，正确密码登录后可访问，错误密码返回 401。

### 从浏览器弹窗迁移

先备份本工具配置、密码文件指纹及数据库，再拉取代码、安装新的 systemd 单元并重启。本机验证 `/healthz` 返回 200、`/api/episodes` 返回 401、`/login` 返回 200 后，才能安装新的 Nginx 配置，移除旧的基本认证。切换过程中不能留下未认证的私人接口。密码文件内容和权限保持不变；已有音频、播放进度不迁移、不清空。

公开认证入口为 `POST /api/auth/login`（JSON `password`、布尔 `remember`），`POST /api/auth/logout`，均要求 `X-JTG-Request: 1`。`GET /api/auth/session` 返回当前认证状态和到期时间，未登录为 401。`GET /healthz` 仅返回存活状态，不包含私人数据。生产健康检查使用该路径。

本地仅监听回环地址；需要测试登录时设置 `AUTH_PASSWORD_FILE` 指向独立测试密码文件，`PUBLIC_ORIGIN=http://127.0.0.1:端口`。未设置密码文件的非生产预览保留免登录模式，生产不允许该模式。

### 删除与磁盘空间

删除前有确认。成功后移除实际音频文件、列表条目和服务端进度；文件删除失败时保留条目并提示失败，不假报成功。其他正在播放该音频的连接结束后，文件占用的磁盘块才会完全释放。

应用没有音频回收站，也不会自动保留音频副本。云盘快照或外部备份是独立副本，不随应用删除自动清理。当前项目未配置音频定时备份。

### 收听边界

联网且使用同一个私人音频库时，可跨浏览器和设备续听；本机缓存不会覆盖云端新进度。未成功同步的记录仍依赖本机数据，不应在离线时清理浏览器数据。
已接入 Media Session 播放、暂停、前后跳转，并在切到后台时保存。不同手机的锁屏与耳机行为需真机确认。
刷新恢复位置后仍需手动点播放，这是有意保留的行为。
