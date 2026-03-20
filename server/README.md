# MC Launcher 信令服务器

P2P 联机的信令服务器，负责房间管理、SDP/ICE 中继和 WebSocket 中继模式。

## 快速开始

```bash
# 安装依赖
npm install

# 配置 (可选: Cloudflare TURN)
cp .env.example .env
# 编辑 .env 填入 CF_TURN_KEY_ID 和 CF_TURN_API_TOKEN

# 开发模式
npm run dev

# 生产构建
npm run build
npm start
```

## 部署方式

### 推荐: Cloudflare Tunnel (零成本)

```bash
# 1. 启动信令服务器
npm start

# 2. 用 cloudflared 创建隧道 (自动获得 HTTPS on 443)
cloudflared tunnel --url http://localhost:8080
# 输出类似: https://abc-123.trycloudflare.com

# 3. 把 URL 填入启动器设置中的"信令服务器地址"
```

### 自建 VPS

```bash
# 1. 上传代码
# 2. npm install && npm run build
# 3. 用 PM2 或 systemd 运行: pm2 start signaling.js
# 4. 前置 Nginx + Let's Encrypt 提供 WSS
```

## 健康检查

```bash
curl http://localhost:8080/health
# {"status":"ok","rooms":0,"peers":0}
```

## 消息协议

所有消息为 JSON 格式, 通过 `type` 字段区分:

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `create-room` | C→S | 创建房间 |
| `room-created` | S→C | 房间已创建, 返回 roomCode |
| `join-room` | C→S | 加入房间 (by roomCode) |
| `room-joined` | S→C | 加入成功, 返回已有 peers |
| `peer-joined` | S→C | 新成员加入通知 |
| `peer-left` | S→C | 成员离开通知 |
| `room-closed` | S→C | 房间解散 |
| `offer/answer/ice-candidate` | C→S→C | WebRTC 信令转发 |
| `relay-data` | C→S→C | WS 中继模式数据帧 |
| `request-turn-credentials` | C→S | 请求 CF TURN 凭据 |
| `turn-credentials` | S→C | 返回 CF TURN iceServers |
