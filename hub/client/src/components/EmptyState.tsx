import { Center, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Optional illustrative icon (e.g. `<TbRocket size={40} />`). */
  icon?: ReactNode;
  /** Optional short headline in plain language. */
  title?: string;
  /** Optional supporting line — a plain string (styled dimmed) or custom nodes. */
  description?: ReactNode;
  /** Optional call-to-action (button or button group). */
  action?: ReactNode;
  /** Fill the available height and center vertically (full-page empty screens). */
  fullHeight?: boolean;
}

/**
 * Consistent empty / first-run state shared by every page. One look-and-feel
 * for "nothing here yet" moments so the user always recognizes the pattern and
 * the suggested next action.
 */
export function EmptyState({ icon, title, description, action, fullHeight }: EmptyStateProps) {
  const content = (
    <Paper p="xl" withBorder maw={520} ta="center">
      <Stack align="center" gap="md">
        {icon}
        {title ? (
          <Title order={2} size="h4">
            {title}
          </Title>
        ) : null}
        {typeof description === 'string' ? (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        ) : (
          description
        )}
        {action}
      </Stack>
    </Paper>
  );
  return fullHeight ? <Center h="100%">{content}</Center> : <Center py="xl">{content}</Center>;
}
