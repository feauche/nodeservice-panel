import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type BillingForecast,
  type BillingItem,
  type BillingPayment,
  type BillingStats,
  type BillingSummary,
  billingArchiveSchema,
  billingExtendResponseSchema,
  billingExtendSchema,
  billingForecastSchema,
  billingItemSchema,
  billingItemsResponseSchema,
  billingItemUpsertSchema,
  billingListQuerySchema,
  billingPaymentSchema,
  billingPaymentsResponseSchema,
  billingPaymentUpdateSchema,
  billingStatsQuerySchema,
  billingStatsSchema,
  billingSummaryQuerySchema,
  billingSummarySchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { BillingService } from './billing.service.js';

export class BillingItemDto extends createZodDto(billingItemSchema) {}
export class BillingItemsResponseDto extends createZodDto(billingItemsResponseSchema) {}
export class BillingItemUpsertDto extends createZodDto(billingItemUpsertSchema) {}
export class BillingExtendDto extends createZodDto(billingExtendSchema) {}
export class BillingExtendResponseDto extends createZodDto(billingExtendResponseSchema) {}
export class BillingPaymentDto extends createZodDto(billingPaymentSchema) {}
export class BillingPaymentsResponseDto extends createZodDto(billingPaymentsResponseSchema) {}
export class BillingPaymentUpdateDto extends createZodDto(billingPaymentUpdateSchema) {}
export class BillingArchiveDto extends createZodDto(billingArchiveSchema) {}
export class BillingSummaryDto extends createZodDto(billingSummarySchema) {}
export class BillingStatsDto extends createZodDto(billingStatsSchema) {}
export class BillingForecastDto extends createZodDto(billingForecastSchema) {}
export class BillingListQueryDto extends createZodDto(billingListQuerySchema) {}
export class BillingSummaryQueryDto extends createZodDto(billingSummaryQuerySchema) {}
export class BillingStatsQueryDto extends createZodDto(billingStatsQuerySchema) {}

/** Биллинг: что и когда оплачивать, продления с курсом ЦБ, итоги по календарным периодам. */
@ApiTags('billing')
@ApiCookieAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('items')
  @ApiOperation({ summary: 'Оплаты по ближайшему сроку; archived=1 — архив' })
  @ApiOkResponse({ type: BillingItemsResponseDto })
  list(@Query() q: BillingListQueryDto): Promise<{ items: BillingItem[] }> {
    return this.billing.list(q.archived === '1');
  }

  @Post('items')
  @Audit('billing.item.created')
  @ApiOperation({ summary: 'Добавить оплату' })
  @ApiOkResponse({ type: BillingItemDto })
  create(@Body() body: BillingItemUpsertDto): Promise<BillingItem> {
    return this.billing.create(body);
  }

  @Put('items/:id')
  @Audit('billing.item.updated')
  @ApiOperation({ summary: 'Изменить оплату' })
  @ApiOkResponse({ type: BillingItemDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: BillingItemUpsertDto): Promise<BillingItem> {
    return this.billing.update(id, body);
  }

  @Delete('items/:id')
  @HttpCode(204)
  @Audit('billing.item.deleted', { severity: 'warn' })
  @ApiOperation({ summary: 'Удалить оплату вместе с историей продлений' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.billing.remove(id);
  }

  @Post('items/:id/archive')
  @HttpCode(200)
  @Audit('billing.item.archived')
  @ApiOperation({ summary: 'Убрать в архив или вернуть из архива' })
  @ApiOkResponse({ type: BillingItemDto })
  archive(@Param('id', ParseUUIDPipe) id: string, @Body() body: BillingArchiveDto): Promise<BillingItem> {
    return this.billing.setArchived(id, body.archived);
  }

  @Post('items/:id/extend')
  @HttpCode(200)
  @Audit('billing.extended')
  @ApiOperation({ summary: 'Продлить: на период карточки, на N дней или до даты; с учётом суммы или без' })
  @ApiOkResponse({ type: BillingExtendResponseDto })
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BillingExtendDto,
  ): Promise<{ item: BillingItem; payment: BillingPayment }> {
    return this.billing.extend(id, body);
  }

  @Get('items/:id/payments')
  @ApiOperation({ summary: 'История продлений оплаты' })
  @ApiOkResponse({ type: BillingPaymentsResponseDto })
  payments(@Param('id', ParseUUIDPipe) id: string): Promise<{ items: BillingPayment[] }> {
    return this.billing.payments(id);
  }

  @Patch('payments/:id')
  @Audit('billing.payment.updated')
  @ApiOperation({ summary: 'Поправить дату или сумму записи оплаты (курс — на новую дату)' })
  @ApiOkResponse({ type: BillingPaymentDto })
  updatePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BillingPaymentUpdateDto,
  ): Promise<BillingPayment> {
    return this.billing.updatePayment(id, body);
  }

  @Delete('payments/:id')
  @Audit('billing.payment.undone')
  @ApiOperation({ summary: 'Отменить последнее продление (409 — не последнее или дату уже меняли)' })
  @ApiOkResponse({ type: BillingItemDto })
  undo(@Param('id', ParseUUIDPipe) id: string): Promise<BillingItem> {
    return this.billing.undo(id);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Итоги за день, неделю, месяц, год; ближайшая оплата; оплаты по серверам' })
  @ApiOkResponse({ type: BillingSummaryDto })
  summary(@Query() q: BillingSummaryQueryDto): Promise<BillingSummary> {
    return this.billing.summary(q.tz);
  }

  @Get('forecast')
  @ApiOperation({ summary: 'Прогноз оплат: 7 и 30 дней, до конца года, в год, по неделям и месяцам' })
  @ApiOkResponse({ type: BillingForecastDto })
  forecast(@Query() q: BillingSummaryQueryDto): Promise<BillingForecast> {
    return this.billing.forecast(q.tz);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Статистика за период с разбивкой по провайдерам, типам и месяцам года' })
  @ApiOkResponse({ type: BillingStatsDto })
  stats(@Query() q: BillingStatsQueryDto): Promise<BillingStats> {
    return this.billing.stats(q.period, q.tz);
  }
}
