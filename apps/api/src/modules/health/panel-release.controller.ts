import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type PanelRelease, panelReleaseSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { PanelReleaseService } from './panel-release.service.js';

class PanelReleaseDto extends createZodDto(panelReleaseSchema) {}

@ApiTags('system')
@ApiCookieAuth()
@Controller('system')
export class PanelReleaseController {
  constructor(private readonly releases: PanelReleaseService) {}

  @Get('release')
  @ApiOperation({ summary: 'Установленная и последняя стабильная версия панели' })
  @ApiOkResponse({ type: PanelReleaseDto })
  latest(): Promise<PanelRelease> {
    return this.releases.latest();
  }
}
