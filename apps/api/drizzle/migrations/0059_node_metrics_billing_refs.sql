ALTER TABLE billing_items ADD COLUMN node_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE remna_metric_samples (
 panel text NOT NULL, node_uuid uuid NOT NULL, sampled_at timestamptz NOT NULL,
 values jsonb NOT NULL,
 PRIMARY KEY (panel, node_uuid, sampled_at)
);
CREATE INDEX remna_metric_samples_time_idx ON remna_metric_samples (sampled_at);
