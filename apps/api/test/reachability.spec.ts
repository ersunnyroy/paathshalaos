/**
 * M34.1 — what the product cannot do, counted.
 *
 * M32 gave thirteen modules a write surface and wrote down the lesson: *a
 * service test proves a function works and cannot prove anybody can call it.*
 * M33 found the same failure one level out — four functions whose comments
 * described a scheduled caller that did not exist. Both were found by looking.
 * Neither left anything behind that would notice the next one.
 *
 * This does. It walks every `xService` / `xRepository` object in `src/`, finds
 * the methods nothing calls, and requires each of them to be listed below with
 * a reason. A method that becomes unreachable and is not listed fails the
 * suite; a method that is listed and has since been wired up also fails it, so
 * the list cannot rot into a page of stale apologies.
 *
 * ## Why a list and not just a count
 *
 * A count is a number somebody bumps. A named list with reasons is an
 * inventory — the first honest one this product has had of what it contains
 * and cannot do — and every line of it is a promise the code makes that
 * nothing keeps.
 *
 * ## What this deliberately does not do
 *
 * It does not fail on the number being large. Sixty-odd methods are
 * unreachable today and most of them are somebody's afternoon, not an
 * emergency. What it refuses is the number growing quietly, which is how all
 * sixty got there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : sources(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every `owner.method` this codebase defines, and how many times anything calls
 * it.
 *
 * `this.method(` counts, because a service object's own members call each other
 * that way and an internal helper is not unreachable. Crude, like the SQL check
 * in `query-budget.spec` and for the same reason: it cannot be dodged by a
 * method nobody happened to write a test for.
 */
export function walk(): { scanned: string[]; unreachable: string[] } {
  const files = sources(SRC);
  const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const all = [...text.values()];
  const scanned: string[] = [];
  const unreachable: string[] = [];

  for (const [, t] of text) {
    for (const obj of t.matchAll(/^export const (\w+(?:Service|Repository)) = \{(.*?)^\};/gms)) {
      const owner = obj[1]!;
      for (const m of obj[2]!.matchAll(/^ {2}(?:async )?(\w+)\s*\(/gm)) {
        const name = m[1]!;
        scanned.push(`${owner}.${name}`);
        const called = all.some((u) =>
          new RegExp(`(?:${owner}|this)\\.${name}\\b`).test(u));
        if (!called) unreachable.push(`${owner}.${name}`);
      }
    }
  }
  return { scanned: scanned.sort(), unreachable: unreachable.sort() };
}

export function unreachableMethods(): string[] {
  return walk().unreachable;
}

/**
 * Everything nothing calls, and why.
 *
 * Grouped by the reason rather than the module, because the reason is what a
 * reader needs: "waiting on a payment provider" and "the feature shipped
 * without a write surface" are different kinds of debt and only one of them is
 * anybody's fault.
 */
const UNREACHABLE: Array<{ why: string; methods: string[] }> = [
  {
    why: 'Waiting on a gateway we have not bought. Presenting a mandate, taking '
       + 'a card and accepting a delivery receipt all need a live provider — a '
       + 'receipt endpoint in particular needs a shared secret to check a '
       + 'signature against, and one that trusted anything that posted to it '
       + 'would let a stranger mark a message delivered.',
    methods: [
      'mandateService.byId', 'mandateService.present', 'mandateService.register',
      'mandateService.transition',
      'paymentService.byId', 'paymentService.createOrder', 'paymentService.handleWebhook',
      'dispatchService.recordReceipt',
    ],
  },
  {
    why: 'Reached only by the suite. Not dead — every one is exercised and '
       + 'passing — but a method whose only caller is a test is a method the '
       + 'product does not have. Each is a standalone wrapper around something '
       + 'the live code does differently: `intake` creates the person and the '
       + 'student inside one transaction with the form submission, the mark '
       + 'sheet reads marks with the roster joined, and the retention purge '
       + 'runs as a job on the maintenance connection because the ordinary one '
       + 'cannot see the rows.',
    methods: [
      'peopleRepository.createPerson', 'peopleRepository.createStudent',
      'assessmentService.marksFor',
      'admissionsService.createApplication', 'formsService.submit',
      'retentionService.purgeUnsuccessfulApplicantDocuments',
    ],
  },
  {
    why: 'An internal seam kept for a caller that has not arrived: a cache '
       + 'reset, an alternative entry point, a claim/ack pair the outbox does '
       + 'not yet use.',
    methods: [
      'formsService.clearValidatorCache',
      'localeService.chainForOrganization',
      'outboxService.claimUnpublished', 'outboxService.markPublished',
      'provisioningService.newRequestKey',
    ],
  },
];

const listed = UNREACHABLE.flatMap((g) => g.methods);

/**
 * The two ways this list and the codebase can disagree.
 *
 * Pulled out of the assertions so it can be run against fixtures below. The
 * real codebase agrees with the list — that is the point of keeping it — so a
 * check written only against the real one passes whether or not it works, and
 * a mutation pass proved exactly that: emptying either filter broke nothing.
 * Same trap as the catalogue audit in M29.2 and the month check in M30.3.
 */
export function disagreements(found: string[], written: string[]): {
  missing: string[]; stale: string[];
} {
  return {
    missing: found.filter((m) => !written.includes(m)),
    stale: written.filter((m) => !found.includes(m)),
  };
}

describe('what the product cannot do is written down', () => {
  it('lists every method nothing calls', () => {
    const { missing } = disagreements(unreachableMethods(), listed);

    // A method that stops being reachable and is not listed here. The whole
    // point: the number got to sixty by growing one at a time, quietly.
    expect(missing, 'newly unreachable, and not written down').toEqual([]);
  });

  it('has no stale entries', () => {
    const { stale } = disagreements(unreachableMethods(), listed);

    // The other direction, which matters just as much. A list that keeps
    // apologising for things somebody has since fixed is a list nobody reads.
    expect(stale, 'listed as unreachable but actually called now').toEqual([]);
  });

  it('gives every entry a reason, and names each method once', () => {
    for (const group of UNREACHABLE) {
      expect(group.why.length, 'a reason, not a label').toBeGreaterThan(60);
      expect(group.methods.length).toBeGreaterThan(0);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('is actually looking at this codebase', () => {
    // A walker that walks nothing passes both assertions above, so something
    // has to anchor them to a real codebase.
    //
    // Anchored on how many methods were SCANNED, not on how many came back
    // unreachable. The first version asserted the unreachable count was above
    // twenty, which was true when it was written and false one milestone
    // later — a guard that has to be relaxed every time the number improves is
    // a guard somebody eventually deletes, and it fails in the direction of
    // the work going well.
    const { scanned, unreachable } = walk();
    expect(scanned.length, 'the walker found no service methods at all')
      .toBeGreaterThan(250);
    expect(scanned).toContain('attendanceService.submitSession');
    expect(unreachable.length).toBeLessThan(scanned.length);
  });
});

/**
 * ...and the detector is worth having only if it can tell the two apart.
 *
 * Every real service passes or fails it as a whole, so a version that had
 * stopped working would look identical. Same trap as the catalogue audit in
 * M29.2 and the month check in M30.3, closed the same way.
 */
describe('the detector catches what it claims to', () => {
  it('has found the methods this suite knows are wired', () => {
    const found = unreachableMethods();
    // Wired in M34.2 and M34.3 — if the detector broke, these would reappear.
    for (const wired of [
      'attendanceService.lockSession', 'attendanceService.submitSession',
      'attendanceService.approveCorrection', 'attendanceService.rejectCorrection',
      'attendanceService.pendingCorrections',
      'peopleRepository.findStudentSensitive', 'peopleRepository.guardiansOf',
      // Wired in M34.4: a school could see its branding and not change it.
      'brandingService.set',
      // M35.1: reconciling a settlement never needed a payment gateway, and
      // saying it did kept four working methods behind an excuse.
      'reconciliationService.importSettlement', 'reconciliationService.matchManually',
      'reconciliationService.unmatchedQueue', 'reconciliationService.clearingBalance',
      // M35.2: the white-label domain half that had a read and no write.
      'domainService.addCustom', 'domainService.verify', 'domainService.setPrimary',
      // M35.3: workflow second halves. `impersonationService.request` and
      // `approve` matter most — they are 0054's two-person support path, whose
      // trigger has refused an unapproved session since 0008 and had nothing
      // able to ask for one.
      'impersonationService.request', 'impersonationService.approve',
      'kbService.revise', 'kbService.unpublish', 'ticketService.assign',
      'reportCardService.correct', 'resultService.supersede',
      'enrollmentService.transferCampus',
      'admissionsService.attachDocument', 'admissionsService.verifyDocument',
      // M35.4: readers that had no screen.
      'assessmentService.byId', 'invoiceService.outstandingFor',
      'consentService.isPermitted', 'authService.revokeAllSessions',
      // M36: the academic spine. Before these, nothing in this product could
      // create an academic year, a programme, a subject, a section, a course
      // offering or a room — so a school signing up on Monday could not reach
      // the end of its first day, and every feature above rested on data a
      // developer had inserted by hand.
      'structureService.createYear', 'structureService.addTerm',
      'structureService.activateYear', 'structureService.createProgramme',
      'structureService.createSubject', 'structureService.createRoom',
      'structureService.createClassGroup', 'structureService.createSection',
      'structureService.createCourseOffering', 'structureService.addScheduleSlot',
      'structureService.timetableForStaff', 'structureService.academicUnits',
      // M36: guardian links were reachable only by uploading a CSV.
      'peopleRepository.linkGuardian', 'peopleRepository.endGuardianLink',
      // M36: the list and the AC-4 proof are one query now.
      'peopleRepository.listStudents', 'peopleRepository.findStudent',
      'importService.batch', 'brandingService.setAsPlatform',
    ]) {
      expect(found, `${wired} is reachable`).not.toContain(wired);
    }
  });

  it('still finds one it should', () => {
    // And the reverse: a method this suite knows nobody calls.
    expect(unreachableMethods()).toContain('mandateService.register');
  });
});

describe('the comparison catches a disagreement in either direction', () => {
  it('names a method that became unreachable and was not written down', () => {
    // The direction that matters most: the number got to sixty by growing one
    // at a time, quietly.
    const { missing, stale } = disagreements(
      ['a.one', 'b.two'], ['a.one']);
    expect(missing).toEqual(['b.two']);
    expect(stale).toEqual([]);
  });

  it('names an entry somebody has since fixed', () => {
    // The other direction. A list that keeps apologising for things that
    // already work is a list nobody reads, and then nobody reads the real
    // entries either.
    const { missing, stale } = disagreements(['a.one'], ['a.one', 'c.three']);
    expect(stale).toEqual(['c.three']);
    expect(missing).toEqual([]);
  });

  it('says nothing when they agree', () => {
    expect(disagreements(['a.one'], ['a.one'])).toEqual({ missing: [], stale: [] });
  });
});
