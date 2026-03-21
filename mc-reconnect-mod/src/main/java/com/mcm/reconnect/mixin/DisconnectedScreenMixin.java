package com.mcm.reconnect.mixin;

import com.mcm.reconnect.ReconnectPoller;
import net.minecraft.client.gui.screen.DisconnectedScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.text.Text;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 拦截断线界面，启动自动重连轮询
 */
@Mixin(DisconnectedScreen.class)
public abstract class DisconnectedScreenMixin extends Screen {
    @Unique
    private static final Logger LOGGER = LoggerFactory.getLogger("mc-reconnect");

    @Unique
    private ReconnectPoller poller;

    protected DisconnectedScreenMixin(Text title) {
        super(title);
    }

    @Inject(method = "init", at = @At("RETURN"))
    private void onInit(CallbackInfo ci) {
        LOGGER.info("[mc-reconnect] Disconnected screen detected, starting reconnect poller");
        poller = new ReconnectPoller();
        poller.start();
    }

    @Inject(method = "removed", at = @At("HEAD"))
    private void onRemoved(CallbackInfo ci) {
        if (poller != null) {
            poller.stop();
            poller = null;
        }
    }
}
