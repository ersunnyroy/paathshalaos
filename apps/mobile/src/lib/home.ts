/**
 * Which screen a person lands on.
 *
 * Small enough to look unnecessary and worth having anyway: this app has two
 * jobs now, and sending a driver to the register is a screen that reads "No
 * class" for somebody whose whole reason for holding the phone is the twelve
 * children waiting at the next corner. Roles come from the server, so this is
 * the one decision that has to be made from them.
 *
 * The order matters where somebody holds both. A teacher who also drives is
 * driving when they are on the bus, and the register is the screen they can
 * reach from the bus — not the other way round.
 */
export function homeFor(roles: readonly string[]): '/' | '/bus' {
  const teaches = roles.some((r) =>
    r === 'TEACHER' || r === 'ORG_OWNER' || r === 'CAMPUS_ADMIN');
  if (teaches) return '/';
  return roles.includes('TRANSPORT') ? '/bus' : '/';
}
