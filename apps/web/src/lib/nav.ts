/**
 * What goes in the navigation, and for whom.
 *
 * This is a convenience, not a control. Every screen still asks the API, and
 * row-level security still decides what comes back — a teacher who types
 * `/fees` into the address bar gets the same empty table they always did.
 * What this fixes is the wall: twenty links for somebody who uses three.
 *
 * Kept free of React so the rules are tested in Node. Icons are named, and the
 * shell looks them up.
 */
export type IconName =
  | 'dashboard' | 'inbox' | 'learners' | 'attendance' | 'bus' | 'staff' | 'book'
  | 'award' | 'fees' | 'send' | 'upload' | 'key' | 'shield' | 'check' | 'help'
  | 'plug' | 'code' | 'layers';

export interface NavItem { href: string; label: string; icon: IconName; keywords?: string }
export interface NavGroup { title: string; items: NavItem[] }

export const GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: 'dashboard', keywords: 'home overview' }],
  },
  {
    title: 'Daily',
    items: [
      { href: '/admissions', label: 'Admissions', icon: 'inbox', keywords: 'enquiry application' },
      { href: '/students', label: 'Learners', icon: 'learners', keywords: 'students roster children' },
      { href: '/attendance', label: 'Attendance', icon: 'attendance', keywords: 'register present absent' },
      { href: '/transport', label: 'Transport', icon: 'bus', keywords: 'bus route' },
      { href: '/staff', label: 'Staff', icon: 'staff', keywords: 'teachers leave hr' },
    ],
  },
  {
    title: 'Academics',
    items: [
      { href: '/learning', label: 'Classwork', icon: 'book', keywords: 'homework assignment lesson' },
      { href: '/results', label: 'Results', icon: 'award', keywords: 'marks exam report card' },
      { href: '/academics', label: 'School structure', icon: 'layers', keywords: 'academic year term class section subject room programme' },
    ],
  },
  {
    title: 'Money',
    items: [{ href: '/fees', label: 'Fees', icon: 'fees', keywords: 'invoice payment receipt' }],
  },
  {
    title: 'Operations',
    items: [
      { href: '/messages', label: 'Messages', icon: 'send', keywords: 'notice sms' },
      { href: '/imports', label: 'Imports', icon: 'upload', keywords: 'csv excel upload' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { href: '/access', label: 'Access', icon: 'key', keywords: 'roles permissions' },
      { href: '/consent', label: 'Consent', icon: 'shield', keywords: 'privacy dpdp' },
      { href: '/setup', label: 'Getting started', icon: 'check', keywords: 'onboarding wizard' },
      { href: '/support', label: 'Support', icon: 'help', keywords: 'ticket help' },
      { href: '/integrations', label: 'Integrations', icon: 'plug', keywords: 'webhook api key' },
      { href: '/developers', label: 'Developers', icon: 'code', keywords: 'openapi docs' },
      { href: '/trust', label: 'Trust', icon: 'shield', keywords: 'security audit' },
    ],
  },
];

/**
 * The screens each role works in. A role that is not listed sees everything:
 * hiding a link from somebody because we did not recognise their role would
 * make the product look broken, and nothing here is protecting anything.
 */
const SCREENS: Record<string, readonly string[]> = {
  TEACHER: ['/dashboard', '/students', '/attendance', '/learning', '/results', '/messages', '/support'],
  ACCOUNTANT: ['/dashboard', '/students', '/fees', '/messages', '/imports', '/support'],
  ADMISSIONS: ['/dashboard', '/admissions', '/students', '/messages', '/imports', '/support'],
  TRANSPORT: ['/dashboard', '/transport', '/support'],
  GUARDIAN: ['/dashboard', '/students', '/attendance', '/fees', '/learning', '/results', '/consent'],
  STUDENT: ['/dashboard', '/attendance', '/learning', '/results'],
};

/** The hrefs somebody holding these roles is shown. `null` means all of them. */
export function screensFor(roles: readonly string[]): Set<string> | null {
  if (roles.length === 0) return null;
  const out = new Set<string>();
  for (const role of roles) {
    const screens = SCREENS[role];
    // One unrestricted role is enough: an owner who also teaches is an owner.
    if (!screens) return null;
    for (const href of screens) out.add(href);
  }
  return out;
}

/** The groups as this person sees them; empty groups are dropped. */
export function navFor(roles: readonly string[]): NavGroup[] {
  const allowed = screensFor(roles);
  if (!allowed) return GROUPS;
  return GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => allowed.has(item.href)) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Screens matching what was typed in the command palette.
 *
 * A plain substring match over the label and a few synonyms, label matches
 * first. The term is a literal: nothing typed here is a pattern.
 */
export function matchScreens(groups: readonly NavGroup[], typed: string): NavItem[] {
  const items = groups.flatMap((g) => g.items);
  const term = typed.trim().toLowerCase();
  if (!term) return items;
  const inLabel = items.filter((i) => i.label.toLowerCase().includes(term));
  const inKeywords = items.filter((i) =>
    !inLabel.includes(i) && (i.keywords ?? '').toLowerCase().includes(term));
  return [...inLabel, ...inKeywords];
}
