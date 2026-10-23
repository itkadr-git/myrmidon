import { BotContainerDriver } from './bot-containers/driver.js';
import { IdleStopService } from './idle-stop.js';
import { Db } from '@paperclipai/db';
import { logger } from '../middleware/logger.js';
import { instanceSettingsService } from '../services/instance-settings.js';

let idleStopService: IdleStopService | undefined;

/**
 * Initializes IDLE-STOP at startup. An explicit environment setting wins;
 * otherwise the product default is enabled.
 */
export async function initializeIdleStopService(driver: BotContainerDriver, db: Db): Promise<void> {
  const rawEnabled = process.env.MYRMIDON_IDLE_STOP_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled === undefined
    ? true
    : ['true', '1', 'yes', 'on'].includes(rawEnabled);
  const afterSec = parseInt(process.env.MYRMIDON_IDLE_STOP_AFTER_SEC || '1800', 10);
  const healthTimeoutMs = parseInt(process.env.MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS || '30000', 10);

  let settings: { enabled?: boolean; afterSec?: number; healthTimeoutMs?: number } | undefined;
  try {
    settings = (await instanceSettingsService(db).getGeneral()).idleStop;
  } catch (error) {
    logger.error({ err: error }, 'IDLE-STOP: could not read stored settings at startup; using environment values');
  }
  const effectiveEnabled = typeof settings?.enabled === 'boolean' ? settings.enabled : enabled;
  const effectiveAfterSec = typeof settings?.afterSec === 'number' ? settings.afterSec : afterSec;
  const effectiveHealthTimeoutMs = typeof settings?.healthTimeoutMs === 'number' ? settings.healthTimeoutMs : healthTimeoutMs;
  idleStopService = new IdleStopService(driver, db, {
    enabled: effectiveEnabled,
    afterSec: effectiveAfterSec,
    healthTimeoutMs: effectiveHealthTimeoutMs,
  }, logger);
  idleStopService.start();

  logger.info(`IDLE-STOP service initialized: afterSec=${effectiveAfterSec}, healthTimeoutMs=${effectiveHealthTimeoutMs}`);
}

export function getIdleStopService(): IdleStopService | undefined {
  return idleStopService;
}

export function shutdownIdleStopService(): void {
  if (idleStopService) {
    idleStopService.stop();
    logger.info('IDLE-STOP service shut down');
  }
}
