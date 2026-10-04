import { Router } from 'express';
import myrmidonBotDiskRoutes from './myrmidon-bot-disk.js';

export function myrmidonBotDiskLifecycleRoutes(db: any) {
  const router = Router();
  
  // Mount the bot disk lifecycle routes under the appropriate path
  router.use('/myrmidon/bot-disk', myrmidonBotDiskRoutes);
  
  return router;
}