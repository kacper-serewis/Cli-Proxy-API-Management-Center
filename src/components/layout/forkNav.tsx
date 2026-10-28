/**
 * Sidebar for this local setup: hides pages that do not apply to an OAuth-only proxy
 * (API-key providers, the apikey.fun quick start, plugins) and adds the Fork page.
 * The routes stay reachable by URL.
 */

import { IconSidebarSystem } from '@/components/ui/icons';

const HIDDEN_PATHS = new Set(['/quick-start', '/ai-providers', '/plugins', '/plugin-store']);

const FORK_NAV_ITEM = {
  path: '/fork',
  label: 'Fork & updates',
  meta: 'Our changes and updater runs',
  icon: <IconSidebarSystem size={18} />,
};

export function applyForkNav<G extends { id: string; items: readonly unknown[] }>(groups: G[]): G[] {
  return groups
    .map((group) => {
      const items = group.items.filter(
        (item) => !(typeof item === 'object' && item !== null && 'path' in item && HIDDEN_PATHS.has(String(item.path)))
      );
      if (group.id === 'observe') items.push(FORK_NAV_ITEM);
      return { ...group, items } as G;
    })
    .filter((group) => group.items.length > 0);
}
