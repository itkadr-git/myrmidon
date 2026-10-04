# FORAGING-IDLE-GATE Feature Guide

## Overview

The FORAGING-IDLE-GATE feature ensures that foraging (knowledge collection from approved sources) only occurs when there are no queued tasks for a role and there is a free agent available. This implements the product rule that training (foraging) should only happen during idle time, with working tasks taking priority.

## Purpose

The purpose of this feature is to prevent foraging activities from competing with regular work tasks for agent resources. Foraging will only proceed when:

1. There are no tasks in the role's queue (tasks with status "todo" or "in_progress" assigned to the role)
2. There is at least one idle agent available for the role

## Configuration

The feature is controlled by the following environment variable:

- `MYRMIDON_FORAGING_IDLE_GATE_ENABLED`: Enables or disables the idle gate functionality
  - Default: `1` (enabled)
  - Set to `0` to disable the idle gate and allow foraging regardless of queue/agent status

Other related configuration options:
- `MYRMIDON_FORAGING_ENABLED`: Controls whether foraging is enabled overall
- `MYRMIDON_FORAGING_BUDGET_CENTS`: Sets the per-pass cost ceiling
- `MYRMIDON_FORAGING_INTERVAL_SEC`: Sets the sweep interval in seconds

## Behavior

When the idle gate is enabled:

1. Before starting a foraging pass, the system checks each role that has enabled foraging sources
2. For each role, it verifies:
   - That there are no tasks in the role's queue
   - That there is at least one idle agent available for the role
3. If either condition is not met, the foraging pass is skipped for that role with a reason:
   - `queue_not_empty`: When there are tasks in the role's queue
   - `no_idle_agent`: When no idle agents are available for the role
4. If both conditions are met, foraging proceeds normally

When the idle gate is disabled, foraging runs according to the schedule regardless of queue or agent status.

## Result Information

The foraging sweep result includes a `skippedReason` field when the pass is skipped due to the idle gate:

- `queue_not_empty`: Foraging skipped because there were tasks in the role queue
- `no_idle_agent`: Foraging skipped because no idle agents were available for the role
- Absent: Foraging ran normally

## Testing

Unit tests cover the following scenarios:
1. Foraging runs normally when idle gate is disabled
2. Foraging is skipped when queue is not empty and idle gate is enabled
3. Foraging is skipped when no idle agent is available and idle gate is enabled
4. Foraging runs when queue is empty and idle agent is available