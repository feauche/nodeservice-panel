import { Global, Module } from '@nestjs/common';

import { CookiesService } from './cookies.service.js';
import { CsrfService } from './csrf.service.js';

@Global()
@Module({
  providers: [CookiesService, CsrfService],
  exports: [CookiesService, CsrfService],
})
export class HttpModule {}
