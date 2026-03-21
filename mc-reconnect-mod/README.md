# MC Auto-Reconnect Mod (Fabric)

实验性 Fabric 客户端 Mod，用于共享世界主机迁移时自动重连。

## 原理

当玩家因主机迁移被断开连接时：
1. Mixin 拦截 `DisconnectedScreen`，检测断线原因
2. 启动器通过 `.mc-reconnect.json` 文件通知 Mod 新主机地址
3. Mod 轮询该文件，检测到新地址后自动连接

## 文件协议

启动器在 `.minecraft/` 目录下写入 `.mc-reconnect.json`:

```json
{
  "action": "reconnect",
  "host": "127.0.0.1",
  "port": 25565,
  "timestamp": 1700000000000
}
```

Mod 读取后自动连接并删除该文件。

## 构建

```bash
cd mc-reconnect-mod
./gradlew build
```

输出: `build/libs/mc-reconnect-mod-1.0.0.jar`

## 兼容性

- Minecraft 1.20.x ~ 1.21.x
- Fabric Loader 0.15+
- Fabric API 不需要
