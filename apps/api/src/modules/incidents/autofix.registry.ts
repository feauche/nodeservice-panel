import type { AutofixPresetKey } from '@nodeservice/shared';

/**
 * Команды автопочинки — ТОЛЬКО из этого реестра (никаких shell-строк из БД).
 * Каждая безопасна и идемпотентна; выполняется по SSH ключом панели.
 */
export const AUTOFIX_COMMANDS: Record<AutofixPresetKey, string> = {
  restart_xray:
    "sh -c 'systemctl restart xray 2>/dev/null || docker restart remnanode 2>/dev/null || docker restart $(docker ps -q -f name=xray 2>/dev/null) 2>/dev/null || true'",
  restart_node: "sh -c 'docker restart remnanode 2>/dev/null || true'",
  free_disk: "sh -c 'journalctl --vacuum-size=200M 2>/dev/null; docker system prune -f 2>/dev/null; true'",
};
