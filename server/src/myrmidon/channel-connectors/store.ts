// The single data-access seam over the vendor chat tables.
// Design: docs/myrmidon/design/chat-channel-connector.md, section 3.3.
//
// Connectors never write SQL of their own: they ask the store the hub hands
// them. Step S1 ships the one read the hub needs to route an outbound
// publication by provider; the later steps add the reads and the writes the
// connectors ask for, one method at a time, so the vendor tables keep a single
// reader and the port stays cheap.

import { eq } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import {
  isChatProviderName,
  type ChannelConnectorStore,
  type ChannelEndpointView,
  type ChatProviderName,
} from "./contract.js";

/** The store over the vendor chat tables. */
export function channelConnectorStore(db: Db): ChannelConnectorStore {
  return {
    /** The endpoint by id, or null when the id is unknown to the contract — a
     *  missing row and a provider outside our set both read as null, so the hub
     *  leaves them to the vendor path. */
    async readEndpoint(endpointId: string): Promise<ChannelEndpointView | null> {
      const rows = await db
        .select({
          id: chatEndpoints.id,
          companyId: chatEndpoints.companyId,
          provider: chatEndpoints.provider,
          publicId: chatEndpoints.publicId,
          status: chatEndpoints.status,
        })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .limit(1);

      const row = rows[0];
      if (row === undefined || !isChatProviderName(row.provider)) {
        return null;
      }
      const provider: ChatProviderName = row.provider;

      return {
        id: row.id,
        companyId: row.companyId,
        provider,
        publicId: row.publicId,
        status: row.status,
      };
    },
  };
}