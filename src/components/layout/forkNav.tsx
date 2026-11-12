/**
 * Sidebar for this local setup: hides pages that do not apply to an OAuth-only proxy
 * (API-key providers, the apikey.fun quick start, plugins) and adds the Chats and Fork pages.
 * The routes stay reachable by URL.
 */

import { IconSidebarSystem } from '@/components/ui/icons';

const HIDDEN_PATHS = new Set(['/quick-start', '/ai-providers', '/plugins', '/plugin-store']);

const CHATS_ICON = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </svg>
);

const CHATS_NAV_ITEM = {
  path: '/chats',
  label: 'Chats',
  meta: 'What every chat says, live',
  icon: CHATS_ICON,
};

const FORK_NAV_ITEM = {
  path: '/fork',
  label: 'Fork & updates',
  meta: 'Our changes and updater runs',
  icon: <IconSidebarSystem size={18} />,
};

export function applyForkNav<G extends { id: string; items: readonly unknown[] }>(
  groups: G[]
): G[] {
  return groups
    .map((group) => {
      const items = group.items.filter(
        (item) =>
          !(
            typeof item === 'object' &&
            item !== null &&
            'path' in item &&
            HIDDEN_PATHS.has(String(item.path))
          )
      );
      if (group.id === 'observe') {
        const quota = items.findIndex(
          (item) =>
            typeof item === 'object' && item !== null && 'path' in item && item.path === '/quota'
        );
        items.splice(quota + 1, 0, CHATS_NAV_ITEM);
        items.push(FORK_NAV_ITEM);
      }
      return { ...group, items } as G;
    })
    .filter((group) => group.items.length > 0);
}
