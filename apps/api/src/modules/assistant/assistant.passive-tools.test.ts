import { describe, expect, it } from 'vitest';
import { PASSIVE_ASSISTANT_TOOLS } from './assistant.tools.js';

describe('PASSIVE_ASSISTANT_TOOLS', () => {
  it('видит парк и ноды, но не получает действий, SSH и записи', () => {
    const names = new Set(PASSIVE_ASSISTANT_TOOLS.map((tool) => tool.name));
    expect(names).toEqual(
      new Set([
        'get_remnawave_profiles',
        'get_remnawave_topology',
        'list_incidents',
        'get_incident',
        'get_playbook',
        'get_reference',
        'get_billing',
        'get_settings',
        'get_panel_status',
        'get_node_metrics',
        'get_remnawave_status',
        'get_node_detail',
        'search_audit',
        'search_conversations',
        'search_kb',
      ]),
    );
    expect(names).not.toContain('check_reachability');
    expect(names).not.toContain('inspect_processes');
    expect(names).not.toContain('inspect_node_logs');
    expect(names).not.toContain('run_server_check');
    expect(names).not.toContain('save_kb_article');
    expect(names).not.toContain('add_glossary_terms');
    expect(names).not.toContain('propose_action');
    expect(names).not.toContain('propose_change');
  });
});
