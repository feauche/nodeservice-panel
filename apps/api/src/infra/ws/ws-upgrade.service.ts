import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Один слушатель `upgrade` на весь HTTP-сервер: маршрутизирует WebSocket по пути.
 * Агент-шлюз и веб-терминал регистрируют сюда свои пути; неизвестный путь — сокет закрывается.
 */
@Injectable()
export class WsUpgradeService {
  private readonly log = new Logger(WsUpgradeService.name);
  private readonly routes = new Map<string, UpgradeHandler>();

  register(path: string, handler: UpgradeHandler): void {
    this.routes.set(path, handler);
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const handler = this.routes.get(path);
      if (!handler) {
        socket.destroy();
        return;
      }
      handler(req, socket, head);
    });
    this.log.log(`WebSocket-роутер активен: ${[...this.routes.keys()].join(', ')}`);
  }
}
