import { Module } from '@nestjs/common';

import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeRepository } from './knowledge.repository.js';
import { KnowledgeService } from './knowledge.service.js';

/** Этап 9: база знаний (markdown-статьи, полнотекстовый поиск). */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeRepository, KnowledgeService],
  exports: [KnowledgeRepository, KnowledgeService],
})
export class KnowledgeModule {}
