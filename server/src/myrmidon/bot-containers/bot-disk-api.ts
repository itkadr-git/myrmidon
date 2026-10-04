import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "../../routes/authz.js";
import { readBotDiskSettings, writeBotDiskSettings, type BotDiskSettings } from "./bot-disk-store.js";
import { getBotContainerRuntime } from "./routes-wiring.js"; // myrmidon(1.6.1-BOT-DISK-B): to update driver config

export function botDiskApi(db: Db) {
  const router = Router();

  router.get("/myrmidon/bot-disk", async (req, res) => {
    assertBoard(req);
    
    const settings = await readBotDiskSettings(db);
    // Return the common contract as specified by the lead
    res.json({
      "shared.packageStore": settings.sharedPackageCachePath,
      "shared.enabled": !!settings.sharedPackageCachePath,
      // Include the original keys for backward compatibility
      sharedPackageCachePath: settings.sharedPackageCachePath,
    });
  });

  router.patch("/myrmidon/bot-disk", async (req, res) => {
    assertBoard(req);
    
    // The request body follows the common contract
    const requestBody = req.body;
    const sharedPackageStorePath = requestBody["shared.packageStore"];
    const sharedEnabled = requestBody["shared.enabled"];
    
    // Process the request according to the contract priorities
    let newSettings: BotDiskSettings;
    
    if (requestBody.hasOwnProperty("shared.packageStore")) {
      // shared.packageStore has priority when present
      newSettings = {
        sharedPackageCachePath: sharedPackageStorePath || undefined,
      };
    } else if (requestBody.hasOwnProperty("sharedPackageCachePath")) {
      // Fallback to the original key
      newSettings = {
        sharedPackageCachePath: requestBody.sharedPackageCachePath || undefined,
      };
    } else {
      // If neither is present, keep current settings
      const currentSettings = await readBotDiskSettings(db);
      newSettings = currentSettings;
    }
    
    // If shared.enabled is explicitly false and package store path is not set, clear the path
    if (sharedEnabled === false && !sharedPackageStorePath) {
      newSettings = { sharedPackageCachePath: undefined };
    }
    
    const updatedSettings = await writeBotDiskSettings(db, newSettings);
    
    // Update the driver configuration with the new cache path
    const runtime = getBotContainerRuntime();
    runtime?.driver.updateSharedPackageCachePath?.(updatedSettings.sharedPackageCachePath);
    
    // Return response in the common contract format
    res.json({ 
      message: "Bot disk settings updated successfully", 
      settings: {
        "shared.packageStore": updatedSettings.sharedPackageCachePath,
        "shared.enabled": !!updatedSettings.sharedPackageCachePath,
        // Include the original keys for backward compatibility
        sharedPackageCachePath: updatedSettings.sharedPackageCachePath,
      } 
    });
  });

  return router;
}