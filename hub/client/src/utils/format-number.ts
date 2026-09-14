const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const fullFormatter = new Intl.NumberFormat('en-US');

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return compactFormatter.format(value).toLowerCase();
}

export function formatFullNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return fullFormatter.format(value);
}
