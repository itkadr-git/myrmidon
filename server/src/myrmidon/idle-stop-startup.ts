import { BotContainerDriver } from './bot-containers/driver.js';
import { IdleStopService } from './idle-stop.js';
import { Db } from '@paperclipai/db';
import { logger } from '../middleware/logger.js';

let idleStopService: IdleStopService | undefined;

/**
 * Initializes IDLE-STOP at startup. An explicit environment setting wins;
 * otherwise the product default is enabled.
 */
export function initializeIdleStopService(driver: BotContainerDriver, db: Db): void {
  const rawEnabled = process.env.MYRMIDON_IDLE_STOP_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled === undefined
    ? true
    : ['true', '1', 'yes', 'on'].includes(rawEnabled);
  const afterSec = parseInt(process.env.MYRMIDON_IDLE_STOP_AFTER_SEC || '1800', 10);
  const healthTimeoutMs = parseInt(process.env.MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS || '30000', 10);

  if (!enabled) {
    logger.info('IDLE-STOP service is disabled (MYRMIDON_IDLE_STOP_ENABLED=false)');
    return;
  }

  idleStopService = new IdleStopService(driver, db, {
    enabled,
    afterSec,
    healthTimeoutMs,
  }, logger);
  idleStopService.start();

  logger.info(`IDLE-STOP service initialized: afterSec=${afterSec}, healthTimeoutMs=${healthTimeoutMs}`);
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
