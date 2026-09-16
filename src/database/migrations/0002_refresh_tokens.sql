CREATE TABLE "root"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "root"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "root"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "root"."refresh_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "root"."refresh_tokens" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "root"."refresh_tokens" USING btree ("expires_at");