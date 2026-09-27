-- История версий базы знаний: что конкретно изменилось (пока только для пополнения глоссария Джарвисом).
ALTER TABLE "kb_document_versions" ADD COLUMN "summary" jsonb;
