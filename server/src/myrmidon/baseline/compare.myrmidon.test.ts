import { describe, it, expect, beforeEach } from 'vitest';
import { compareWithBaseline } from './service.js';
import type { BaselineMetricsResponse } from './service.js';
import type { BaselineGroupMetrics } from './metrics.js';

// Mock data for testing
const mockGroupMetrics: BaselineGroupMetrics = {
  key: 'test-project',
  tasksCompleted: 20,
  cycleTimeHours: {
    mean: 100000,
    median: 95000,
    p90: 120000,
  },
  timeInReviewHours: {
    mean: 20000,
    median: 18000,
  },
  returnRate: {
    enteredReview: 100,
    returned: 15,
    rate: 0.15,
  },
  blockedHours: {
    total: 5,
    mean: 3600,
    topCauses: [],
  },
  runsPerTask: {
    total: 60,
    mean: 3,
  },
  costPerTask: {
    totalCents: 50000,
    meanCents: 2500,
  },
};

const mockCurrentMetrics: BaselineMetricsResponse = {
  window: { from: '2023-09-19T08:28:00.000Z', to: '2023-10-03T08:28:00.000Z' },
  generatedAt: new Date().toISOString(),
  source: { statusLog: 'activity_log', costs: 'litellm_cost_events' as const },
  byProject: [mockGroupMetrics],
  byRole: [mockGroupMetrics],
};

const mockBaselineMetrics: BaselineMetricsResponse = {
  window: { from: '2023-09-05T08:28:00.000Z', to: '2023-09-19T08:28:00.000Z' },
  generatedAt: new Date(Date.now() - 86400000).toISOString(), // Yesterday
  source: { statusLog: 'activity_log', costs: 'litellm_cost_events' as const },
  byProject: [{ ...mockGroupMetrics, cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 80000 } }],
  byRole: [{ ...mockGroupMetrics, cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 80000 } }],
};

describe('Baseline Comparison Service', () => {
  describe('compareWithBaseline', () => {
    it('should calculate differences correctly when baseline exists', () => {
      const result = compareWithBaseline(mockCurrentMetrics, mockBaselineMetrics);

      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('baseline');
      expect(result).toHaveProperty('differences');

      // Check that current and baseline data are preserved
      expect(result.current).toEqual(mockCurrentMetrics);
      expect(result.baseline).toEqual(mockBaselineMetrics);

      // Check that differences are calculated properly
      expect(result.differences).toHaveProperty('cycleTimeMean');
      expect(result.differences).toHaveProperty('returnRate');
      expect(result.differences).toHaveProperty('costPerTask');

      // All difference values should be objects with absolute and percentage values (except where baseline is null)
      if (result.differences.cycleTimeMean) {
        expect(typeof result.differences.cycleTimeMean.absolute).toBe('number');
        expect(typeof result.differences.cycleTimeMean.percentage).toBe('number');
      }
      if (result.differences.returnRate) {
        expect(typeof result.differences.returnRate.absolute).toBe('number');
        expect(typeof result.differences.returnRate.percentage).toBe('number');
      }
    });

    it('should return baseline: null when no baseline snapshot is provided', () => {
      const result = compareWithBaseline(mockCurrentMetrics, null);

      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('baseline');
      expect(result).toHaveProperty('differences');

      expect(result.current).toEqual(mockCurrentMetrics);
      expect(result.baseline).toBeNull();

      // When there's no baseline, all differences should be null
      Object.values(result.differences).forEach(diff => {
        expect(diff).toBeNull();
      });
    });

    it('should handle edge cases in difference calculation', () => {
      // Test with zero values to ensure no division by zero
      const metricsWithZero = {
        ...mockCurrentMetrics,
        byProject: [{
          ...mockGroupMetrics,
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 0 },
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0 },
        }],
        byRole: [{
          ...mockGroupMetrics,
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 0 },
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0 },
        }],
      };

      const result = compareWithBaseline(metricsWithZero, mockBaselineMetrics);

      // Should handle zero values gracefully
      expect(result.differences.costPerTask).toBeDefined();
      expect(result.differences.returnRate).toBeDefined();
    });

    it('should correctly calculate positive and negative differences', () => {
      // Create a baseline with lower values (better performance)
      const betterBaseline: BaselineMetricsResponse = {
        ...mockBaselineMetrics,
        byProject: [{
          ...mockGroupMetrics,
          cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 80000 }, // Better (lower) cycle time
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0.10 },         // Better (lower) return rate
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 2000 },  // Better (lower) cost
        }],
        byRole: [{
          ...mockGroupMetrics,
          cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 80000 }, // Better (lower) cycle time
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0.10 },         // Better (lower) return rate
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 2000 },  // Better (lower) cost
        }],
      };

      const result = compareWithBaseline(mockCurrentMetrics, betterBaseline);

      // When current is worse than baseline, differences should show negative impact
      if (result.differences.cycleTimeMean) {
        expect(result.differences.cycleTimeMean.absolute).toBeGreaterThan(0);
        expect(result.differences.cycleTimeMean.percentage).toBeGreaterThan(0);
      }
      if (result.differences.returnRate) {
        expect(result.differences.returnRate.absolute).toBeGreaterThan(0);
        expect(result.differences.returnRate.percentage).toBeGreaterThan(0);
      }
      if (result.differences.costPerTask) {
        expect(result.differences.costPerTask.absolute).toBeGreaterThan(0);
        expect(result.differences.costPerTask.percentage).toBeGreaterThan(0);
      }

      // Now test with better current metrics
      const worseBaseline: BaselineMetricsResponse = {
        ...mockBaselineMetrics,
        byProject: [{
          ...mockGroupMetrics,
          cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 120000 }, // Worse (higher) cycle time
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0.20 },           // Worse (higher) return rate
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 3000 },    // Worse (higher) cost
        }],
        byRole: [{
          ...mockGroupMetrics,
          cycleTimeHours: { ...mockGroupMetrics.cycleTimeHours, mean: 120000 }, // Worse (higher) cycle time
          returnRate: { ...mockGroupMetrics.returnRate, rate: 0.20 },           // Worse (higher) return rate
          costPerTask: { ...mockGroupMetrics.costPerTask, meanCents: 3000 },    // Worse (higher) cost
        }],
      };

      const result2 = compareWithBaseline(mockCurrentMetrics, worseBaseline);

      // When current is better than baseline, differences should show improvement
      if (result2.differences.cycleTimeMean) {
        expect(result2.differences.cycleTimeMean.absolute).toBeLessThan(0);
        expect(result2.differences.cycleTimeMean.percentage).toBeLessThan(0);
      }
      if (result2.differences.returnRate) {
        expect(result2.differences.returnRate.absolute).toBeLessThan(0);
        expect(result2.differences.returnRate.percentage).toBeLessThan(0);
      }
      if (result2.differences.costPerTask) {
        expect(result2.differences.costPerTask.absolute).toBeLessThan(0);
        expect(result2.differences.costPerTask.percentage).toBeLessThan(0);
      }
    });
  });
});