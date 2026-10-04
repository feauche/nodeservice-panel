import { request } from 'node:https';
import { Injectable } from '@nestjs/common';
import { type AgentMetrics, agentMetricsSchema } from '@nodeservice/shared';
import { z } from 'zod';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { ServerRow } from '../../infra/db/schema/index.js';

const responseSchema = z.object({
  serverId: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  metrics: agentMetricsSchema.optional(),
});

const vpnProbeResponseSchema = z.object({
  ok: z.boolean(),
  stage: z.string().max(30),
  detail: z.string().max(4000),
  latencyMs: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

export type AgentVpnProbeResult = z.infer<typeof vpnProbeResponseSchema>;

export interface AgentPullSnapshot {
  serverId: string;
  version: string;
  metrics?: AgentMetrics | undefined;
}

export function certificatePem(derBase64: string): string {
  const body = derBase64.match(/.{1,64}/g)?.join('\n') ?? derBase64;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** Один короткий HTTPS-запрос к агенту. Сертификат и Bearer-ключ уникальны для сервера. */
@Injectable()
export class AgentPullClient {
  constructor(private readonly crypto: CryptoService) {}

  async snapshot(server: ServerRow, metrics: boolean): Promise<AgentPullSnapshot> {
    if (!server.agentListenPort || !server.agentAccessKeyEnc || !server.agentTlsCert)
      throw new Error('входящий канал агента настроен не полностью');
    const accessKey = this.crypto.decrypt(server.agentAccessKeyEnc);
    const tlsCert = server.agentTlsCert;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: server.host,
          port: server.agentListenPort,
          path: `/v1/snapshot?metrics=${metrics ? '1' : '0'}`,
          method: 'GET',
          ca: certificatePem(tlsCert),
          servername: 'nodeservice-agent',
          minVersion: 'TLSv1.3',
          timeout: 5_000,
          headers: { Authorization: `Bearer ${accessKey}`, Accept: 'application/json' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length < 64 * 1024) body += chunk;
            else req.destroy(new Error('ответ агента слишком большой'));
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`агент ответил ${res.statusCode ?? 'без статуса'}`));
              return;
            }
            try {
              const parsed = responseSchema.parse(JSON.parse(body));
              if (parsed.serverId !== server.id) throw new Error('агент ответил с другим serverId');
              resolve(parsed);
            } catch (err) {
              reject(
                new Error(`ответ агента повреждён: ${err instanceof Error ? err.message : String(err)}`),
              );
            }
          });
        },
      );
      req.once('timeout', () => req.destroy(new Error('таймаут подключения к агенту')));
      req.once('error', reject);
      req.end();
    });
  }

  async vpnProbe(server: ServerRow, link: string, token: string): Promise<AgentVpnProbeResult> {
    if (!server.agentListenPort || !server.agentAccessKeyEnc || !server.agentTlsCert)
      throw new Error('входящий канал агента настроен не полностью');
    const accessKey = this.crypto.decrypt(server.agentAccessKeyEnc);
    const body = JSON.stringify({ link, token });
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: server.host,
          port: server.agentListenPort,
          path: '/v1/vpn-probe',
          method: 'POST',
          ca: certificatePem(server.agentTlsCert as string),
          servername: 'nodeservice-agent',
          minVersion: 'TLSv1.3',
          timeout: 28_000,
          headers: {
            Authorization: `Bearer ${accessKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let response = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (response.length < 16 * 1024) response += chunk;
            else req.destroy(new Error('ответ VPN-пробы слишком большой'));
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`агент ответил ${res.statusCode ?? 'без статуса'}`));
              return;
            }
            try {
              resolve(vpnProbeResponseSchema.parse(JSON.parse(response)));
            } catch (err) {
              reject(
                new Error(`ответ VPN-пробы повреждён: ${err instanceof Error ? err.message : String(err)}`),
              );
            }
          });
        },
      );
      req.once('timeout', () => req.destroy(new Error('таймаут VPN-пробы агента')));
      req.once('error', reject);
      req.end(body);
    });
  }
}
