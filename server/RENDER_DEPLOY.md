# Render 部署说明

## 一键部署到 Render（免费）

### 前提
- GitHub 账号
- Render 账号（render.com，免费注册）

### 步骤

1. **推送 server 目录到 GitHub 仓库**

   创建一个新的 GitHub 仓库（如 `mc-signaling`），只推送 `server/` 下的信令服务器代码：

   ```bash
   cd server
   git init
   git add signaling.ts package.json tsconfig.json .env.example
   git commit -m "signaling server"
   git remote add origin https://github.com/你的用户名/mc-signaling.git
   git push -u origin main
   ```

2. **在 Render 创建 Web Service**

   - 登录 render.com → New → Web Service
   - 关联 GitHub 仓库 `mc-signaling`
   - 配置：
     - **Name**: `mc-signaling`
     - **Region**: Singapore（离中国最近的免费区域）
     - **Branch**: `main`
     - **Runtime**: Node
     - **Build Command**: `npm install && npm run build`
     - **Start Command**: `npm start`
     - **Instance Type**: Free

3. **设置环境变量**

   在 Render Dashboard → Environment 中添加：

   | Key | Value |
   |-----|-------|
   | `CF_TURN_KEY_ID` | `70dfe683336d125e07aacf1625df3225` |
   | `CF_TURN_API_TOKEN` | `562acf22855107e9e22315c7a246adae41dc7c4acb260f7d610dda747ac5ab7a` |
   | `PORT` | `10000`（Render 默认端口） |

4. **部署完成**

   Render 会自动构建并部署，得到 URL 如：
   `https://mc-signaling.onrender.com`

   WebSocket 地址：`wss://mc-signaling.onrender.com`

5. **更新启动器默认信令地址**

   将 `src/types/index.ts` 和 `src/stores/settings.ts` 中的
   `wss://signal.yjn159.online` 改为 Render 的地址。

   也可以保留两个都支持（Render 主 + Cloudflare Tunnel 备）。

## 注意事项

- Free 实例 15 分钟无请求后休眠，首次唤醒约 30 秒
- 房主创建房间时服务唤醒，客人加入时已经是热的
- 免费额度：750 小时/月（单实例 24x31=744 小时，刚好够）
