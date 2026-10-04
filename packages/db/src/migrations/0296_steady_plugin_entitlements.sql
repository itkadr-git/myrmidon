-- Migration: plugin_entitlements

-- Create plugin entitlements table
CREATE TABLE plugin_entitlements (
    id TEXT PRIMARY KEY DEFAULT (uuid_generate_v7()),
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    entitlement_key TEXT NOT NULL, -- The actual entitlement key (hashed/storage-safe)
    public_key TEXT NOT NULL,      -- Public key for signature verification
    instance_id TEXT NOT NULL,     -- Instance this entitlement is valid for
    expires_at TIMESTAMPTZ NOT NULL, -- Expiration timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX idx_plugin_entitlements_plugin_id ON plugin_entitlements(plugin_id);
CREATE INDEX idx_plugin_entitlements_instance_id ON plugin_entitlements(instance_id);
CREATE INDEX idx_plugin_entitlements_expires_at ON plugin_entitlements(expires_at);

-- Trigger to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_plugin_entitlements_updated_at 
    BEFORE UPDATE ON plugin_entitlements 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS policies
ALTER TABLE plugin_entitlements ENABLE ROW LEVEL SECURITY;

-- Policy to allow instance admins to manage their own plugin entitlements
CREATE POLICY instance_admin_plugin_entitlements_policy ON plugin_entitlements
    FOR ALL TO myrmidon_instance_admin
    USING (instance_id = get_current_instance_id())
    WITH CHECK (instance_id = get_current_instance_id());