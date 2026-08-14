import { Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Page title — pass an already-translated string. */
  title: string;
  /** Optional one-line subtitle in plain language. */
  description?: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Optional right-aligned actions (buttons, selects, badges). */
  actions?: ReactNode;
}

/**
 * Consistent page header used across every page. Standardizes the
 * `title (+ description) | actions` row so each screen looks the same and the
 * user learns one layout. Replaces the ad-hoc
 * `<Group justify="space-between"><Title order={3}>…</Title>…</Group>` blocks.
 *
 * The title is the page's `h1`. It used to be `order={3}`, which meant no page
 * in the app had an h1 or h2 at all: every document outline started at h3, so
 * assistive tech had no page heading to land on and nothing on screen was
 * confidently the headline. Size comes from the `h1` rung in `theme.ts` (24px),
 * so this is a hierarchy fix, not a "make it bigger" one.
 */
export function PageHeader({ title, description, icon, actions }: PageHeaderProps) {
  return (
    <Group justify="space-between" wrap="wrap" gap="sm">
      <Group gap="sm" wrap="nowrap">
        {icon}
        <Stack gap={2}>
          <Title order={1}>{title}</Title>
          {description ? (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          ) : null}
        </Stack>
      </Group>
      {actions ? <Group gap="xs">{actions}</Group> : null}
    </Group>
  );
}
