# 自行部署与维护

以下是 Linux + Nginx + systemd 的部署参考。请将示例域名 `audio.example.com` 替换成你自己的域名；仓库 `deploy/` 中的配置也要按自己的环境调整。

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

使用已安装的 Node 22.5+、OpenSSL 3、FFmpeg（含 ffprobe）、Nginx、certbot 及支持 `LoadCredential` 的 systemd。确认 `/usr/bin/node` 是合适的版本，端口 4300 空闲。Ubuntu 可使用 `sudo apt-get install --no-install-recommends ffmpeg` 安装音频处理组件；更新到文字制作版本前也需要安装，以便运行完整测试。缺少组件时，原有音频库和文字进度仍可使用，分段上传检查与合并会明确提示不可用。

1. 将仓库 main 克隆到 `/opt/jtg-audio`，运行 `npm ci --omit=dev` 和 `npm test`。
2. 建立无交互登录权限的专用系统用户 `jtg-audio`；数据目录属于该用户，ACME 目录供 Nginx 读取。
3. 准备独立密码文件（SHA-512 crypt，推荐 100000 轮）；安装 `deploy/jtg-audio.service`，`systemctl daemon-reload` 后启用并启动。生产环境缺少密码文件或 HTTPS 配置会拒绝启动。
4. 添加 `audio` 的 A 记录，指向现有服务器。
5. 初次只安装 `deploy/nginx-http.conf` 到本工具独立配置文件，测试 Nginx 后 reload；该配置仅提供证书验证，不暴露应用。
6. `certbot certonly --webroot -w /var/lib/jtg-audio/acme -d audio.example.com` 获取证书；沿用服务器已有 certbot 账户与续期任务。
7. 密码不得出现在命令参数、日志或 GitHub 中。更新密码文件后重启本服务以刷新凭据，旧登录记录随密码版本变化失效。
8. 先确认应用启动并保护私人接口，再安装 `deploy/nginx.conf`，`nginx -t` 通过后 reload。匿名首页跳到 `/login`；登录页及必要样式公开，私人接口/音频仍返回 401，正确密码登录后可访问，错误密码返回 401。

### 从浏览器弹窗迁移

先备份本工具配置、密码文件指纹及数据库，再拉取代码、安装新的 systemd 单元并重启。本机验证 `/healthz` 返回 200、`/api/episodes` 返回 401、`/login` 返回 200 后，才能安装新的 Nginx 配置，移除旧的基本认证。切换过程中不能留下未认证的私人接口。密码文件内容和权限保持不变；已有音频、播放进度不迁移、不清空。

公开认证入口为 `POST /api/auth/login`（JSON `password`、布尔 `remember`），`POST /api/auth/logout`，均要求 `X-JTG-Request: 1`。`GET /api/auth/session` 返回当前认证状态和到期时间，未登录为 401。`GET /healthz` 仅返回存活状态，不包含私人数据。生产健康检查使用该路径。

本地仅监听回环地址；需要测试登录时设置 `AUTH_PASSWORD_FILE` 指向独立测试密码文件，`PUBLIC_ORIGIN=http://127.0.0.1:端口`。未设置密码文件的非生产预览保留免登录模式，生产不允许该模式。
