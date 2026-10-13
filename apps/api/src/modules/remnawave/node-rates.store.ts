import { Injectable } from '@nestjs/common';
import type { RemnawaveNode } from '@nodeservice/shared';

/** Скорость, которой не обновляли дольше, неизвестна: замеры перестали писаться (Remnawave не отвечает). */
const FRESH_MS = 3 * 60_000;

/**
 * Скорость сетевой карты ноды за последнюю записанную минуту (по счётчикам ноды). Пишут замеры, читает статус нод:
 * строка ноды, окно ноды, «Обзор» и Ассистент получают то же число, что на краю графика, а не секундный снимок
 * Remnawave.
 */
@Injectable()
export class NodeRatesStore {
  private readonly rates = new Map<string, { rx: number | null; tx: number | null; at: number }>();
  set(domain: string, uuid: string, rate: { rx: number | null; tx: number | null }, at: number) {
    this.rates.set(`${domain}|${uuid}`, { ...rate, at });
    if (this.rates.size > 5000) this.rates.clear();
  }
  apply(domain: string, node: RemnawaveNode): RemnawaveNode {
    const r = this.rates.get(`${domain}|${node.uuid}`);
    const fresh = r && Date.now() - r.at < FRESH_MS;
    return { ...node, rxBytesPerSec: fresh ? r.rx : null, txBytesPerSec: fresh ? r.tx : null };
  }
}
