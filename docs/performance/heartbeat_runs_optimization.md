# Performance Optimization for Heartbeat Runs

## Overview

This optimization addresses performance issues with heartbeat runs by:

1. Eliminating duplicate storage of `executionContinuation` data
2. Optimizing database queries to avoid selecting heavy JSON columns unnecessarily
3. Adding performance indexes to speed up common queries

## Changes

### Database Query Optimizations

#### Conversation Ownership Blocker
- Changed `getConversationOwnershipBlocker()` to select only required columns instead of `SELECT *`
- Reduced query overhead by selecting specific fields: `id`, `agentId`, `processPid`, `processGroupId`, `status`, `createdAt`, `processStartedAt`

#### Heartbeat Runs List
- Added `includeHeavyColumns` option to `list()` function
- When `includeHeavyColumns` is `false`, excludes heavy JSON columns like `resultJson`, `contextSnapshot` details, and error fields
- Maintains backward compatibility with default `true` value

#### Attention Feed
- Optimized `listAttentionExhaustedRunsWithoutHeavyColumns()` function to exclude heavy columns
- Used in attention feed to reduce payload size and improve performance

### Database Migrations

#### Migration 0303: Remove Execution Continuation Duplication
- Removes duplicate storage of `executionContinuation` field
- Ensures the field is stored only once inside `paperclipWake` object

## Performance Impact

These optimizations achieve:
- Reduction in `heartbeat_runs` table size by eliminating duplicate data
- Decreased query execution time for common operations
- Lower memory usage when loading run data
- Faster attention feed loading times