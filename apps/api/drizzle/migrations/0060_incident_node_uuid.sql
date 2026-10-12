ALTER TABLE incidents ADD COLUMN node_uuid uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX incidents_node_open_unique ON incidents (node_uuid, kind) WHERE node_uuid IS NOT NULL AND status <> 'resolved';
