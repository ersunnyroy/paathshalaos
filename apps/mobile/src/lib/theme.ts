/** The brand sheet, as the app uses it. Same values as the web design tokens. */
export const theme = {
  teal: '#14B8A6',
  navy: '#0F172A',
  slate: '#334155',
  line: '#E2E8F0',
  background: '#F8FAFC',
  good: '#15803D',
  warning: '#B45309',
  critical: '#B91C1C',
} as const;

/**
 * What each attendance state looks like.
 *
 * Present is deliberately the quiet one: a register is mostly present, and
 * colouring every row teaches people to stop reading the colour. The
 * exceptions are what the teacher is actually marking.
 */
export const stateColour: Record<string, string> = {
  present: theme.slate,
  absent: theme.critical,
  late: theme.warning,
  excused: theme.teal,
  half_day: theme.warning,
};
