CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"auth_method" text DEFAULT 'panel-key' NOT NULL,
	"ssh_private_key_enc" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"hostname" text,
	"os" text,
	"os_version" text,
	"arch" text,
	"kernel" text,
	"cpu_cores" integer,
	"memory_mb" integer,
	"host_key_fp" text,
	"agent_status" text DEFAULT 'not_installed' NOT NULL,
	"ssh_ok" boolean,
	"last_ssh_check_at" timestamp with time zone,
	"last_ssh_ok_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_name_unique" UNIQUE("name"),
	CONSTRAINT "servers_host_port_unique" UNIQUE("host","port"),
	CONSTRAINT "servers_auth_method_check" CHECK ("auth_method" IN ('panel-key', 'key')),
	CONSTRAINT "servers_agent_status_check" CHECK ("agent_status" IN ('not_installed', 'pending', 'online', 'offline'))
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "enrollment_tokens_server_idx" ON "enrollment_tokens" ("server_id");
