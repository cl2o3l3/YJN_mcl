package com.mcm.reconnect;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.multiplayer.ConnectScreen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.network.ServerAddress;
import net.minecraft.client.network.ServerInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 轮询 .mc-reconnect.json 文件，检测到重连指令后自动连接新主机
 */
public class ReconnectPoller {
    private static final Logger LOGGER = LoggerFactory.getLogger("mc-reconnect");
    private static final Gson GSON = new Gson();
    private static final long POLL_INTERVAL_MS = 1000;
    private static final long MAX_WAIT_MS = 60_000;

    private final Path reconnectFile;
    private volatile boolean running;
    private Thread pollThread;

    public ReconnectPoller() {
        Path gameDir = MinecraftClient.getInstance().runDirectory.toPath();
        this.reconnectFile = gameDir.resolve(".mc-reconnect.json");
    }

    public void start() {
        if (running) return;
        running = true;

        pollThread = new Thread(() -> {
            long startTime = System.currentTimeMillis();
            LOGGER.info("[mc-reconnect] Starting poll for reconnect file: {}", reconnectFile);

            while (running && (System.currentTimeMillis() - startTime) < MAX_WAIT_MS) {
                try {
                    if (Files.exists(reconnectFile)) {
                        String content = Files.readString(reconnectFile);
                        JsonObject json = GSON.fromJson(content, JsonObject.class);

                        if ("reconnect".equals(json.get("action").getAsString())) {
                            String host = json.get("host").getAsString();
                            int port = json.get("port").getAsInt();

                            // 基本验证
                            if (host == null || host.isEmpty() || port <= 0 || port > 65535) {
                                LOGGER.warn("[mc-reconnect] Invalid reconnect data: {}:{}", host, port);
                                Files.deleteIfExists(reconnectFile);
                                continue;
                            }

                            LOGGER.info("[mc-reconnect] Reconnect signal detected: {}:{}", host, port);
                            Files.deleteIfExists(reconnectFile);

                            // 在主线程执行连接
                            MinecraftClient client = MinecraftClient.getInstance();
                            client.execute(() -> {
                                ServerAddress address = new ServerAddress(host, port);
                                ServerInfo serverInfo = new ServerInfo("SharedWorld", address.getAddress(), ServerInfo.ServerType.OTHER);
                                ConnectScreen.connect(new TitleScreen(), client, address, serverInfo, false, null);
                            });

                            running = false;
                            return;
                        }
                    }

                    Thread.sleep(POLL_INTERVAL_MS);
                } catch (IOException | InterruptedException e) {
                    if (running) {
                        LOGGER.warn("[mc-reconnect] Poll error: {}", e.getMessage());
                    }
                    break;
                }
            }

            LOGGER.info("[mc-reconnect] Poll ended (timeout or stopped)");
        }, "mc-reconnect-poller");

        pollThread.setDaemon(true);
        pollThread.start();
    }

    public void stop() {
        running = false;
        if (pollThread != null) {
            pollThread.interrupt();
        }
    }
}
