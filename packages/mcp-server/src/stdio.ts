#!/usr/bin/env node
import { PRODUCT_NAME } from "@myrmidon/shared";
import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error(`Failed to start ${PRODUCT_NAME} MCP server:`, error);
  process.exit(1);
});
