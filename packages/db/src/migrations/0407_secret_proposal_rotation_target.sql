ALTER TABLE "company_secret_proposals" ADD COLUMN "rotation_target_secret_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_rotation_target_secret_id_company_secrets_id_fk" FOREIGN KEY ("rotation_target_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
