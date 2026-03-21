package com.mcm.reconnect;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ReconnectMod implements ClientModInitializer {
    public static final String MOD_ID = "mc-reconnect";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitializeClient() {
        LOGGER.info("[mc-reconnect] Auto-reconnect mod loaded");
    }
}
