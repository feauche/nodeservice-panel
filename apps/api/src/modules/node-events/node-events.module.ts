import { Global, Module } from '@nestjs/common';
import { NodeEventsStore } from './node-events.store.js';
/** Shared append-only history; provider modules publish sanitized facts, metrics reads them locally. */
@Global()
@Module({ providers: [NodeEventsStore], exports: [NodeEventsStore] })
export class NodeEventsModule {}
