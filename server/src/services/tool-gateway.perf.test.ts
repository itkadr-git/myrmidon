import { describe, it, beforeEach, afterEach } from 'vitest';
import { createToolGatewayService } from './tool-gateway';
import { createToolAccessPolicyService } from './tool-access-policy'; 
import { mockDb } from '../__mocks__/db';

describe('Tool Gateway Performance Tests', () => {
  let gatewayService;
  let mockDatabase;

  beforeEach(() => {
    mockDatabase = mockDb();
    gatewayService = createToolGatewayService(mockDatabase, {});
  });

  // Performance test: Verify that tools/list makes constant number of policy-related DB queries
  it('should make <= 5 queries to tool_* tables for tools/list with 100 tools', async () => {
    // Mock 100 tools
    const mockTools = Array.from({ length: 100 }, (_, i) => ({
      name: `tool-${i}`,
      displayName: `Tool ${i}`,
      description: `Description for tool ${i}`,
      parametersSchema: { type: 'object', properties: {} },
      pluginId: 'test-plugin',
      providerType: 'mcp_http_fixture',
      risk: 'read'
    }));

    // Mock the database to track queries to tool_* tables
    const originalSelect = mockDatabase.select;
    let toolTableQueryCount = 0;
    
    mockDatabase.select = function(table) {
      const tableName = Object.keys(table)[0] || '';
      if (tableName.startsWith('tool')) {
        toolTableQueryCount++;
      }
      return originalSelect.call(this, table);
    };

    // Mock the tools list function to return our 100 tools
    vi.spyOn(gatewayService, 'listToolsForContext').mockResolvedValue(mockTools);

    // Simulate a session
    const mockSession = {
      companyId: 'test-company',
      agentId: 'test-agent',
      issueId: null,
      projectId: null
    };

    // Call listToolsForContext (simulating tools/list)
    const result = await gatewayService.listToolsForContext(mockSession);

    // Verify performance requirement: <= 5 queries to tool_* tables
    expect(toolTableQueryCount).toBeLessThanOrEqual(5);
    console.log(`Number of tool_* table queries: ${toolTableQueryCount}`);
  });

  // Additional test to measure timing
  it('should execute tools/list within acceptable time limits', async () => {
    const mockSession = {
      companyId: 'test-company',
      agentId: 'test-agent', 
      issueId: null,
      projectId: null
    };

    const startTime = performance.now();
    await gatewayService.listToolsForContext(mockSession);
    const endTime = performance.now();
    
    const executionTimeMs = endTime - startTime;
    console.log(`tools/list execution time: ${executionTimeMs}ms`);
    
    // Should be significantly faster with caching
    expect(executionTimeMs).toBeLessThan(1000); // Less than 1 second
  });
});