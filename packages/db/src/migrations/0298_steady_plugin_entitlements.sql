CREATE TABLE "plugin_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	"public_key" text NOT NULL,
	"instance_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_entitlements" ADD CONSTRAINT "plugin_entitlements_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_plugin_entitlements_plugin_id" ON "plugin_entitlements" USING btree ("plugin_id");
--> statement-breakpoint
CREATE INDEX "idx_plugin_entitlements_instance_id" ON "plugin_entitlements" USING btree ("instance_id");
--> statement-breakpoint
CREATE INDEX "idx_plugin_entitlements_expires_at" ON "plugin_entitlements" USING btree ("expires_at");
