ALTER TABLE "root"."users" ADD COLUMN "role" varchar(30) DEFAULT 'admin' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_company_email_unique" ON "root"."users" USING btree ("company_id","email");--> statement-breakpoint
CREATE INDEX "users_company_id_idx" ON "root"."users" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "users_email_lower_idx" ON "root"."users" USING btree (lower("email"));