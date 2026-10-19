import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IdleStopService, type IdleStopConfig, type IdleStopLogger } from './idle-stop.js';
import { BotContainerDriver, BotContainerStatus } from './bot-containers/driver.js';
import { heartbeatRuns, agents, botApplyJobs, instanceSettings } from '@paperclipai/db';

vi.mock('@paperclipai/db', () => ({
  heartbeatRuns: {
    id: 'id',
    agentId: 'agent_id',
    status: 'status',
    finishedAt: 'finished_at',
    startedAt: 'started_at',
    createdAt: 'created_at',
  },
  agents: {
    id: 'id',
    adapterType: 'adapter_type',
    status: 'status',
    adapterConfig: 'adapter_config',
  },
  botApplyJobs: {
    id: 'id',
    botId: 'bot_id',
    status: 'status',
  },
  instanceSettings: {
    singletonKey: 'singleton_key',
    general: 'general',
  },
}));

vi.mock('./maintenance/store.js', () => ({
  readMaintenanceDocument: vi.fn().mockResolvedValue({ windows: [] }),
}));

describe('IdleStopService', () => {
  let mockDriver: BotContainerDriver;
  let mockDb: any;
  let mockLogger: IdleStopLogger;
  let idleStopService: IdleStopService;

  const testConfig: IdleStopConfig = {
    enabled: true,
    afterSec: 300, // 5 minutes
    healthTimeoutMs: 30000,
    sweepIntervalMs: 60000,
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockDriver = {
      status: vi.fn(),
      stop: vi.fn(),
      stopIdle: vi.fn(),
      start: vi.fn(),
      list: vi.fn(),
      templateDrift: vi.fn(),
      create: vi.fn(),
      recreate: vi.fn(),
      writeProfile: vi.fn(),
      restart: vi.fn(),
    } as any;

    // Mock db with chainable query builder
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn(),
    };

    idleStopService = new IdleStopService(mockDriver, mockDb, testConfig, mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockListBotKeys(mockDb: any, botKeys: string[]) {
    // Use a dedicated mock so that the main mockDb.select is free for other queries.
    // The implementation returns a thenable that resolves to the bot key rows.
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((resolve: any) =>
            resolve(botKeys.map((id) => ({ agentId: id }))),
          ),
        }),
      }),
    });
  }

  describe('sweeper functionality', () => {
    it('should not stop container with active runs', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'running' },
      ]);

      // resolveAgentId: agent exists
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: botKey }])),
            }),
          }),
        }),
      });
      // hasActiveRuns: active run found
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: 'run-1' }])),
            }),
          }),
        }),
      });

      await idleStopService.performSweep();

      expect(mockDriver.list).toHaveBeenCalledWith([botKey]);
      expect(mockDriver.stop).not.toHaveBeenCalled();
    });

    it('should stop container without active runs for longer than threshold', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'running' },
      ]);

      let runsQueryCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === botApplyJobs) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([])),
                }),
              }),
            };
          }
          if (table === agents) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: botKey }])),
                }),
              }),
            };
          }
          if (table === heartbeatRuns) {
            runsQueryCount++;
            if (runsQueryCount === 1) {
              return {
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    then: vi.fn().mockImplementation((resolve: any) => resolve([])), // No active runs
                  }),
                }),
              };
            }
            const oldDate = new Date(Date.now() - 400000); // 400 seconds ago
            return {
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    then: vi.fn().mockImplementation((resolve: any) =>
                      resolve([{ finishedAt: oldDate, startedAt: oldDate }]),
                    ),
                  }),
                }),
              }),
            };
          }
          return { where: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ then: (r: any) => r([]) }) }) };
        }),
      }));

      await idleStopService.performSweep();

      expect(mockDriver.stopIdle).toHaveBeenCalledWith(botKey);
    });

    it('should not stop container that was recently active', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'running' },
      ]);

      let runsQueryCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === botApplyJobs) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([])),
                }),
              }),
            };
          }
          if (table === agents) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: botKey }])),
                }),
              }),
            };
          }
          if (table === heartbeatRuns) {
            runsQueryCount++;
            if (runsQueryCount === 1) {
              return {
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    then: vi.fn().mockImplementation((resolve: any) => resolve([])), // No active runs
                  }),
                }),
              };
            }
            const recentDate = new Date(Date.now() - 200000); // 200 seconds ago
            return {
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    then: vi.fn().mockImplementation((resolve: any) =>
                      resolve([{ finishedAt: recentDate, startedAt: recentDate }]),
                    ),
                  }),
                }),
              }),
            };
          }
          return { where: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ then: (r: any) => r([]) }) }) };
        }),
      }));

      await idleStopService.performSweep();

      expect(mockDriver.stop).not.toHaveBeenCalled();
    });

    it('should skip non-running containers', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'stopped' },
      ]);

      await idleStopService.performSweep();

      expect(mockDriver.stop).not.toHaveBeenCalled();
      // only the listBotKeys agents query ran; no per-container run queries
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('should not stop container with health status starting', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        {
          botKey,
          state: 'running',
          inspect: { State: { Health: { Status: 'starting' } } } as any,
        },
      ]);

      await idleStopService.performSweep();

      expect(mockDriver.stopIdle).not.toHaveBeenCalled();
      expect(mockDriver.stop).not.toHaveBeenCalled();
    });

    it('should not stop container with uptime less than afterSec', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        {
          botKey,
          state: 'running',
          inspect: { State: { StartedAt: new Date(Date.now() - 60000).toISOString() } } as any,
        },
      ]);

      await idleStopService.performSweep();

      expect(mockDriver.stopIdle).not.toHaveBeenCalled();
      expect(mockDriver.stop).not.toHaveBeenCalled();
    });

    it('should not stop container undergoing apply job', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'running' },
      ]);

      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === agents) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: botKey }])),
                }),
              }),
            };
          }
          if (table === heartbeatRuns) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([])),
                }),
              }),
            };
          }
          if (table === botApplyJobs) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: 'job-1' }])),
                }),
              }),
            };
          }
          return { where: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ then: (r: any) => r([]) }) }) };
        }),
      }));

      await idleStopService.performSweep();

      expect(mockDriver.stopIdle).not.toHaveBeenCalled();
      expect(mockDriver.stop).not.toHaveBeenCalled();
    });

    it('should not stop container under active maintenance window', async () => {
      const botKey = '550e8400-e29b-41d4-a716-446655440000';
      const { readMaintenanceDocument } = await import('./maintenance/store.js');
      vi.mocked(readMaintenanceDocument).mockResolvedValueOnce({
        windows: [
          {
            id: 'win-1',
            scope: { type: 'agent', id: botKey },
            state: 'leaving',
            companyId: 'comp-1',
            reason: 'rollout',
            onTimeout: 'interrupt_and_retry',
            createdAt: '2026-10-19T00:00:00Z',
          } as any,
        ],
      } as any);

      mockListBotKeys(mockDb, [botKey]);
      vi.mocked(mockDriver.list).mockResolvedValue([
        { botKey, state: 'running' },
      ]);

      mockDb.select.mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === agents) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([{ id: botKey }])),
                }),
              }),
            };
          }
          if (table === heartbeatRuns) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([])),
                }),
              }),
            };
          }
          if (table === botApplyJobs) {
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  then: vi.fn().mockImplementation((resolve: any) => resolve([])),
                }),
              }),
            };
          }
          return { where: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ then: (r: any) => r([]) }) }) };
        }),
      }));

      await idleStopService.performSweep();

      expect(mockDriver.stopIdle).not.toHaveBeenCalled();
      expect(mockDriver.stop).not.toHaveBeenCalled();
    });
  });

  describe('wake functionality', () => {
    it('should return true immediately if container is already running', async () => {
      const botKey = 'running-bot';

      vi.mocked(mockDriver.status).mockResolvedValue({
        botKey,
        state: 'running',
      });

      const result = await idleStopService.wake(botKey);

      expect(result).toBe(true);
      expect(mockDriver.start).not.toHaveBeenCalled();
    });

    it('should start a stopped container and wait for health', async () => {
      const botKey = 'stopped-bot';

      vi.mocked(mockDriver.status)
        .mockResolvedValueOnce({ botKey, state: 'stopped' })
        .mockResolvedValueOnce({ botKey, state: 'running' });

      const result = await idleStopService.wake(botKey);

      expect(result).toBe(true);
      expect(mockDriver.start).toHaveBeenCalledWith(botKey);
    });

    it('should return true without starting anything for an agent without a bot container', async () => {
      const botKey = 'host-run-agent';
      vi.mocked(mockDriver.status).mockResolvedValue({ botKey, state: 'missing' });
      mockListBotKeys(mockDb, []);

      await expect(idleStopService.wake(botKey)).resolves.toBe(true);
      expect(mockDriver.start).not.toHaveBeenCalled();
    });

    it('should return false if container is missing', async () => {
      const botKey = 'missing-bot';
      mockListBotKeys(mockDb, [botKey]);

      vi.mocked(mockDriver.status).mockResolvedValue({
        botKey,
        state: 'missing',
      });

      const result = await idleStopService.wake(botKey);

      expect(result).toBe(false);
      expect(mockDriver.start).not.toHaveBeenCalled();
    });

    it('should log cold start duration', async () => {
      const botKey = 'cold-start-bot';

      vi.mocked(mockDriver.status)
        .mockResolvedValueOnce({ botKey, state: 'stopped' })
        .mockResolvedValueOnce({ botKey, state: 'running' });

      await idleStopService.wake(botKey);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cold start completed'),
      );
    });
  });

  describe('ensureStartedAndHealthy', () => {
    it('should return immediately if container is running', async () => {
      const botKey = 'running-bot';

      vi.mocked(mockDriver.status).mockResolvedValue({
        botKey,
        state: 'running',
      });

      await expect(idleStopService.ensureStartedAndHealthy(botKey)).resolves.toBeUndefined();
      expect(mockDriver.start).not.toHaveBeenCalled();
    });

    it('should start container and verify health', async () => {
      const botKey = 'stopped-bot';

      vi.mocked(mockDriver.status)
        .mockResolvedValueOnce({ botKey, state: 'stopped' })
        .mockResolvedValueOnce({ botKey, state: 'running' });

      await expect(idleStopService.ensureStartedAndHealthy(botKey)).resolves.toBeUndefined();
      expect(mockDriver.start).toHaveBeenCalledWith(botKey);
    });

    it('should not block a run of an agent without a bot container (antigravity_local, no adapterConfig.container)', async () => {
      const botKey = 'host-run-agent';
      vi.mocked(mockDriver.status).mockResolvedValue({ botKey, state: 'missing' });
      mockListBotKeys(mockDb, []);

      await expect(idleStopService.ensureStartedAndHealthy(botKey)).resolves.toBeUndefined();
      expect(mockDriver.start).not.toHaveBeenCalled();
    });

    it('should throw error if container is missing', async () => {
      const botKey = 'missing-bot';
      mockListBotKeys(mockDb, [botKey]);

      vi.mocked(mockDriver.status).mockResolvedValue({
        botKey,
        state: 'missing',
      });

      await expect(idleStopService.ensureStartedAndHealthy(botKey)).rejects.toThrow(
        'Container for bot missing-bot is missing',
      );
    });

    it('should throw timeout error if container does not become healthy', async () => {
      const botKey = 'slow-bot';
      const shortTimeoutConfig: IdleStopConfig = {
        ...testConfig,
        healthTimeoutMs: 100, // Very short timeout
      };

      idleStopService = new IdleStopService(mockDriver, mockDb, shortTimeoutConfig);

      vi.mocked(mockDriver.status).mockResolvedValue({
        botKey,
        state: 'stopped',
      });

      // Mock start to hang
      vi.mocked(mockDriver.start).mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      await expect(idleStopService.ensureStartedAndHealthy(botKey)).rejects.toThrow(
        'Timeout waiting for container health',
      );
    });

    it('should do nothing when disabled', async () => {
      const disabledConfig: IdleStopConfig = {
        ...testConfig,
        enabled: false,
      };

      idleStopService = new IdleStopService(mockDriver as any, mockDb, disabledConfig);

      await expect(idleStopService.ensureStartedAndHealthy('any-bot')).resolves.toBeUndefined();
      expect(mockDriver.status).not.toHaveBeenCalled();
    });
  });

  describe('disabled functionality', () => {
    it('should not run sweep when disabled', async () => {
      const disabledConfig: IdleStopConfig = {
        ...testConfig,
        enabled: false,
      };

      idleStopService = new IdleStopService(mockDriver as any, mockDb, disabledConfig);
      await idleStopService.performSweep();

      expect(mockDriver.list).not.toHaveBeenCalled();
    });

    it('should return true for wake when disabled (passthrough)', async () => {
      const disabledConfig: IdleStopConfig = {
        ...testConfig,
        enabled: false,
      };

      idleStopService = new IdleStopService(mockDriver as any, mockDb, disabledConfig);

      const result = await idleStopService.wake('any-bot');

      expect(result).toBe(true);
    });
  });
});
