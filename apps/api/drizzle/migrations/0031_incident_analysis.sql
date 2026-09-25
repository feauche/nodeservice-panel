-- Разбор инцидента ассистентом (R4.2): вывод, доказательства, шаг, вопросы. Хранится в самом инциденте.
ALTER TABLE "incidents" ADD COLUMN "analysis" jsonb;
