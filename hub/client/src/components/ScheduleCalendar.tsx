import type { RunRequest } from '@hub/shared';
import { Group, Paper, SegmentedControl, Stack, Text } from '@mantine/core';
import type { DateStringValue } from '@mantine/dates';
import {
  getStartOfWeek,
  MonthView,
  type ScheduleEventData,
  ScheduleHeader,
  WeekView,
} from '@mantine/schedule';
import { CronExpressionParser } from 'cron-parser';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useT } from '~/i18n/index.js';

interface ScheduleItem {
  id: string;
  name: string;
  cron: string;
  config: RunRequest;
  enabled: boolean;
}

interface ScheduleCalendarProps {
  schedules: ScheduleItem[];
}

/** Expand cron expressions into discrete events for the next 30 days. */
function expandToEvents(schedules: ScheduleItem[]): ScheduleEventData[] {
  const events: ScheduleEventData[] = [];
  const horizonEnd = dayjs().add(30, 'day').toDate();

  for (const s of schedules) {
    if (!s.enabled) continue;
    try {
      const interval = CronExpressionParser.parse(s.cron, {
        currentDate: dayjs().subtract(1, 'minute').toDate(),
        endDate: horizonEnd,
      });
      let count = 0;
      while (count < 100) {
        try {
          const next = interval.next();
          const start = dayjs(next.toDate());
          events.push({
            id: `${s.id}-${count}`,
            title: s.name,
            start: start.format('YYYY-MM-DD HH:mm:ss'),
            end: start.add(1, 'hour').format('YYYY-MM-DD HH:mm:ss'),
            color: 'gray',
            payload: { scheduleId: s.id, cron: s.cron, config: s.config },
          });
          count++;
        } catch {
          break;
        }
      }
    } catch {
      // skip invalid cron
    }
  }
  return events;
}

export function ScheduleCalendar({ schedules }: ScheduleCalendarProps) {
  const t = useT();
  const [view, setView] = useState<'month' | 'week'>('month');
  const [date, setDate] = useState<string>(dayjs().format('YYYY-MM-DD HH:mm:ss'));

  const events = useMemo(() => expandToEvents(schedules), [schedules]);

  const enabledCount = schedules.filter((s) => s.enabled).length;

  function getWeekRangeLabel(date: DateStringValue) {
    const start = dayjs(getStartOfWeek({ date, firstDayOfWeek: 1 }));
    const end = start.add(6, 'day');
    if (start.month() === end.month()) {
      return `${start.format('MMM D')} – ${end.format('D, YYYY')}`;
    }
    return `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;
  }

  if (schedules.length === 0) {
    return null;
  }

  return (
    <Paper p="md" withBorder>
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {t('schedule.calendarTitle')}
          </Text>
          <Text size="xs" c="dimmed">
            {t(
              enabledCount === 1 ? 'schedule.calendarSummaryOne' : 'schedule.calendarSummary',
            ).replace('{n}', String(enabledCount))}
          </Text>
        </Stack>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as 'month' | 'week')}
          data={[
            { value: 'month', label: t('schedule.calendarMonth') },
            { value: 'week', label: t('schedule.calendarWeek') },
          ]}
        />
      </Group>
      {view === 'month' ? (
        <>
          <ScheduleHeader>
            <ScheduleHeader.Previous
              onClick={() =>
                setDate(
                  dayjs(date)
                    .subtract(1, 'month')
                    .startOf('month')
                    .format('YYYY-MM-DD') as DateStringValue,
                )
              }
            />
            <ScheduleHeader.MonthYearSelect
              yearValue={dayjs(date).year()}
              monthValue={dayjs(date).month()}
              onYearChange={(year) =>
                setDate(
                  dayjs(date).year(year).startOf('month').format('YYYY-MM-DD') as DateStringValue,
                )
              }
              onMonthChange={(month) =>
                setDate(
                  dayjs(date).month(month).startOf('month').format('YYYY-MM-DD') as DateStringValue,
                )
              }
            />
            <ScheduleHeader.Next
              onClick={() =>
                setDate(
                  dayjs(date)
                    .add(1, 'month')
                    .startOf('month')
                    .format('YYYY-MM-DD') as DateStringValue,
                )
              }
            />
          </ScheduleHeader>
          <MonthView
            date={date}
            onDateChange={setDate}
            events={events}
            firstDayOfWeek={1}
            withHeader={false}
          />
        </>
      ) : (
        <>
          <ScheduleHeader>
            <ScheduleHeader.Previous
              onClick={() =>
                setDate(dayjs(date).subtract(1, 'week').format('YYYY-MM-DD') as DateStringValue)
              }
            />
            <ScheduleHeader.Control interactive={false} miw={200}>
              {getWeekRangeLabel(date)}
            </ScheduleHeader.Control>
            <ScheduleHeader.Next
              onClick={() =>
                setDate(dayjs(date).add(1, 'week').format('YYYY-MM-DD') as DateStringValue)
              }
            />
            <ScheduleHeader.Today
              onClick={() => setDate(dayjs().format('YYYY-MM-DD') as DateStringValue)}
            />
          </ScheduleHeader>
          <WeekView
            date={date}
            onDateChange={setDate}
            events={events}
            startTime="00:00:00"
            endTime="23:59:59"
            firstDayOfWeek={1}
            withHeader={false}
          />
        </>
      )}
    </Paper>
  );
}
