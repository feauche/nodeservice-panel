-- Иконка провайдера: ручная ссылка и фактический источник (для подсказки в форме «Изменить»).
ALTER TABLE "providers" ADD COLUMN "icon_url" text;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "icon_source_url" text;
