import { Group, Paper, Text } from '@mantine/core';
import type { ReactNode } from 'react';

const FILL_MIN_HEIGHT = 560;

interface RunStepProps {
  step: number;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  fill?: boolean;
}

export function RunStep({ step, title, hint, action, children, fill = false }: RunStepProps) {
  return (
    <Paper
      p="md"
      withBorder
      style={{
        flexShrink: fill ? 1 : 0,
        flex: fill ? 1 : undefined,
        minHeight: fill ? FILL_MIN_HEIGHT : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--mantine-spacing-sm)',
      }}
    >
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text size="xs" ff="monospace" c="dimmed">
          {step}
        </Text>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed" ml="auto" truncate>
            {hint}
          </Text>
        )}
        {action && <div style={{ marginLeft: hint ? undefined : 'auto' }}>{action}</div>}
      </Group>
      {children}
    </Paper>
  );
}
