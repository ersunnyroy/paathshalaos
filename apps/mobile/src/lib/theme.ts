import { native } from '@paathshala/ui-tokens';

/**
 * The brand sheet, as the app uses it.
 *
 * Since M39 these are not a copy of the web design tokens but the same values,
 * read from the one package both apps share.
 */
export const theme = native;

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

/**
 * What each boarding state looks like.
 *
 * `no_show` is the loud one and the only one that is: a child the school
 * expected at this corner who was not there is the row a driver must not
 * scroll past. Absent is quiet because the office already knew.
 */
export function boardingColour(kind: string | null): string {
  switch (kind) {
    case 'boarded': return theme.good;
    case 'alighted': return theme.good;
    case 'absent': return theme.slate;
    case 'no_show': return theme.critical;
    default: return theme.line;
  }
}
