// The channel connector registry.
// Design: docs/myrmidon/design/chat-channel-connector.md, section 3.2.
//
// The registry is the only place that knows which channels we have. The core
// asks the hub by the provider of an endpoint and never learns a channel name,
// so a new channel is one registration next to its own module — not a branch in
// a vendor `switch (provider)`.

import type {
  ChannelConnector,
  ChannelLogSink,
  ChannelConnectorStore,
  ChatProviderName,
} from "./contract.js";

/** What a connector factory is built with: the data seam, the journal and the
 *  clock of the hub. A connector therefore needs no vendor type of its own. */
export interface ChannelConnectorFactoryDeps {
  readonly store: ChannelConnectorStore;
  readonly logger: ChannelLogSink;
  readonly now: () => Date;
}

export type ChannelConnectorFactory = (deps: ChannelConnectorFactoryDeps) => ChannelConnector;

const factories = new Map<ChatProviderName, ChannelConnectorFactory>();

/** Register the factory of one provider. Two modules claiming the same provider
 *  is a mistake of ours and not a race to resolve: the second, different factory
 *  throws here, at startup, instead of silently winning at some later call.
 *  Registering the same factory again is allowed, so a module can be loaded
 *  twice without failing. */
export function registerChannelConnector(
  provider: ChatProviderName,
  factory: ChannelConnectorFactory,
): void {
  const existing = factories.get(provider);
  if (existing !== undefined && existing !== factory) {
    throw new Error(`channel connector for "${provider}" is already registered`);
  }
  factories.set(provider, factory);
}

/** Forget the factory of one provider. The tests use it to leave the registry
 *  as they found it. */
export function unregisterChannelConnector(provider: ChatProviderName): void {
  factories.delete(provider);
}

/** The factory of one provider, or null when nobody registered one. */
export function getChannelConnectorFactory(
  provider: ChatProviderName,
): ChannelConnectorFactory | null {
  return factories.get(provider) ?? null;
}

/** Build the connector of one provider, or null when the provider has none. A
 *  null is the pass-through of section 3.2: the vendor path keeps the endpoint.
 *  A factory that answers for another provider throws — the caller of the hub
 *  turns that into the same pass-through. */
export function getChannelConnector(
  provider: ChatProviderName,
  deps: ChannelConnectorFactoryDeps,
): ChannelConnector | null {
  const factory = factories.get(provider);
  if (factory === undefined) {
    return null;
  }
  const connector = factory(deps);
  if (connector.provider !== provider) {
    throw new Error(
      `channel connector factory for "${provider}" answered with a "${connector.provider}" connector`,
    );
  }
  return connector;
}