import { BotContainerDriver } from './bot-containers/driver.js';
import { IdleStopService } from './idle-stop.js';
import { Db } from '@paperclipai/db';
import { logger } from '../middleware/logger.js';

let idleStopService: IdleStopService | undefined;

/**
 * Initializes the IDLE-STOP service if enabled via environment variables.
 * Called from server startup (index.ts) after bot containers are initialized.
 */
export function initializeIdleStopService(driver: BotContainerDriver, db: Db): void {
  const enabled = process.env.MYRMIDON_IDLE_STOP_ENABLED === 'true';
  const afterSec = parseInt(process.env.MYRMIDON_IDLE_STOP_AFTER_SEC || '1800', 10);
  const healthTimeoutMs = parseInt(process.env.MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS || '30000', 10);

  if (enabled) {
    const config = {
      enabled,
      afterSec,
      healthTimeoutMs,
    };

    idleStopService = new IdleStopService(driver, db, config, logger);
    idleStopService.start();

    logger.info(`IDLE-STOP service initialized: afterSec=${afterSec}, healthTimeoutMs=${healthTimeoutMs}`);
  } else {
    logger.info('IDLE-STOP service is disabled (MYRMIDON_IDLE_STOP_ENABLED=false)');
  }
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
