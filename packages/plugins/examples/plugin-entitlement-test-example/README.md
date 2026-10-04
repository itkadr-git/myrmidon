# Entitlement-gated example plugin

myrmidon(PLUGIN-ENTITLEMENT C): an example manifest that opts into the plugin
entitlement gate (`requiresEntitlement: true`). It exists so the gate and the
instance settings UI ("Plugin keys") can be exercised without any real
licensed plugin. No real plugin name appears anywhere in the feature — only
this fixture.

Behavior:

- without an accepted key, the plugin is never activated (no worker, no UI
  slots, hidden from menus and settings);
- after the instance admin accepts a key for id `example.entitlement-gated`
  in the instance settings, the next loader activation pass activates it —
  no server restart needed.

See `docs/myrmidon/guides/plugin-entitlement-keys.md` for the full contract.
