/**
 * The bus run, against the mistakes that put a child in the wrong place.
 *
 * Every assertion here is about one of three failures: telling the school a
 * child is on a bus they never boarded, losing the fact that a child was not
 * at their stop, and sending the same tap twice.
 */
import { describe, it, expect } from 'vitest';
import {
  initialStates, nextKind, eventsFor, summarise, tally, hhmm, KIND_LABEL,
  stableId, type ManifestRow,
} from '../src/lib/bus.ts';
import { homeFor } from '../src/lib/home.ts';

const row = (over: Partial<ManifestRow> = {}): ManifestRow => ({
  student_id: 'child-1', admission_no: 'D-1',
  given_name: 'Aarav', family_name: 'Kumar',
  stop_id: 'stop-1', stop_name: '4th Block', sequence_no: 1,
  pickup_time: '07:10:00', drop_time: '15:40:00',
  guardian_phone: '+919845000111', boarded_today: null,
  ...over,
});

describe('what the driver starts with', () => {
  it('starts nobody marked', () => {
    // The opposite of the register, deliberately. A driver who forgets to tap
    // must not have told the school that a child who never arrived is aboard.
    expect(initialStates([row(), row({ student_id: 'child-2' })]))
      .toEqual({ 'child-1': null, 'child-2': null });
  });

  it('starts from what the server already recorded', () => {
    // A phone that reconnects mid-run must agree with the morning's marks
    // rather than showing a blank list somebody re-taps.
    expect(initialStates([row({ boarded_today: 'boarded' })]))
      .toEqual({ 'child-1': 'boarded' });
  });
});

describe('what a tap means', () => {
  it('cycles on, absent, not at stop', () => {
    expect(nextKind(null)).toBe('boarded');
    expect(nextKind('boarded')).toBe('absent');
    expect(nextKind('absent')).toBe('no_show');
    expect(nextKind('no_show')).toBe('boarded');
  });

  it('starts the cycle from a state outside it', () => {
    // `alighted` comes from an earlier drop run. Treated as position -1 it
    // would wrap to the end of the cycle and make the first tap mean "not at
    // stop", which is a phone call to a family for no reason.
    expect(nextKind('alighted')).toBe('boarded');
  });

  it('keeps absent and not-at-stop apart', () => {
    // Absent is the office telling the driver not to wait. Not-at-stop is the
    // driver telling the office to ring the house. One label for both is how
    // a missing child becomes a routine row.
    expect(KIND_LABEL.absent).not.toBe(KIND_LABEL.no_show);
  });
});

describe('what gets sent', () => {
  const id = (key: string) => `id:${key}`;
  const clock = () => new Date('2026-09-20T07:14:00Z');

  it('sends only the children the driver actually marked', () => {
    const rows = [row(), row({ student_id: 'child-2' })];
    const events = eventsFor(rows, { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-20', id, clock);

    // An untouched row is a row the driver has not reached, not a child who
    // is absent. Sending it as anything invents a fact about a child.
    expect(events).toHaveLength(1);
    expect(events[0]!.studentId).toBe('child-1');
    expect(events[0]!.kind).toBe('boarded');
  });

  it('does not resend what the server already has', () => {
    const rows = [row({ boarded_today: 'boarded' })];
    expect(eventsFor(rows, { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-20', id, clock)).toEqual([]);
  });

  it('sends a correction of what the server has', () => {
    const rows = [row({ boarded_today: 'boarded' })];
    const events = eventsFor(rows, { 'child-1': 'no_show' },
      'route-1', 'pickup', '2026-09-20', id, clock);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('no_show');
  });

  it('gives the same child the same id on every retry', () => {
    // The whole basis of a safe retry. A random id per tap would mean a driver
    // who corrects a mark queues two events, and the server — which is
    // append-only — would keep both.
    const rows = [row()];
    const first = eventsFor(rows, { 'child-1': 'absent' },
      'route-1', 'pickup', '2026-09-20', id, clock);
    const second = eventsFor(rows, { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-20', id, clock);
    expect(first[0]!.clientEventId).toBe(second[0]!.clientEventId);
  });

  it('keys the id by date and direction as well as by child', () => {
    // The same child boards in the morning and gets off in the afternoon, on
    // the same day, every day. One id per child would make the afternoon a
    // replay of the morning and lose the drop entirely.
    const rows = [row()];
    const pickup = eventsFor(rows, { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-20', id, clock);
    const drop = eventsFor(rows, { 'child-1': 'alighted' },
      'route-1', 'drop', '2026-09-20', id, clock);
    const tomorrow = eventsFor(rows, { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-21', id, clock);
    const ids = new Set([pickup[0]!.clientEventId, drop[0]!.clientEventId,
      tomorrow[0]!.clientEventId]);
    expect(ids.size).toBe(3);
  });

  it('carries the stop and the device clock', () => {
    const events = eventsFor([row()], { 'child-1': 'boarded' },
      'route-1', 'pickup', '2026-09-20', id, clock);
    expect(events[0]!.stopId).toBe('stop-1');
    expect(events[0]!.deviceRecordedAt).toBe('2026-09-20T07:14:00.000Z');
    expect(events[0]!.onDate).toBe('2026-09-20');
  });
});

describe('what the driver is told', () => {
  it('does not call a tunnel a failure', () => {
    // The run IS recorded — on the phone. Telling a driver it failed invites
    // them to redo it on paper, and then to not send it at all.
    const said = summarise({ sent: 0, replayed: 0, failed: 3 }, 3);
    expect(said.tone).toBe('warn');
    expect(said.message).toContain('saved on this phone');
    expect(said.message).not.toMatch(/fail|error/i);
  });

  it('counts a replay as sent', () => {
    expect(summarise({ sent: 2, replayed: 1, failed: 0 }, 0).message)
      .toBe('3 marks sent.');
  });

  it('says so when there was nothing to send', () => {
    expect(summarise({ sent: 0, replayed: 0, failed: 0 }, 0))
      .toEqual({ message: 'Nothing new to send.', tone: 'ok' });
  });

  it('gets the singular right', () => {
    expect(summarise({ sent: 1, replayed: 0, failed: 0 }, 0).message)
      .toBe('1 mark sent.');
    expect(summarise({ sent: 0, replayed: 0, failed: 1 }, 1).message)
      .toContain('1 mark is');
  });
});

describe('the line above the list', () => {
  it('counts on board, missing and not yet reached separately', () => {
    const rows = [row(), row({ student_id: 'c2' }), row({ student_id: 'c3' }),
      row({ student_id: 'c4' })];
    expect(tally(rows, {
      'child-1': 'boarded', c2: 'no_show', c3: 'absent', c4: null,
    })).toEqual({ onBoard: 1, missing: 1, unmarked: 1 });
  });
});

describe('times', () => {
  it('drops the seconds', () => {
    expect(hhmm('07:10:00')).toBe('07:10');
    expect(hhmm(null)).toBe('');
  });
});

describe('the id that has to repeat', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a shape the endpoint will accept', () => {
    // The endpoint validates a UUID. Nothing about this one is random — it is
    // meant to repeat — but it has to pass the schema or a run of marks is
    // rejected on a bus with no signal.
    for (const key of ['2026-09-20:pickup:child-1', '', 'x', 'a'.repeat(200)]) {
      expect(stableId(key), key).toMatch(UUID);
    }
  });

  it('gives the same key the same id, every time', () => {
    expect(stableId('2026-09-20:pickup:child-1'))
      .toBe(stableId('2026-09-20:pickup:child-1'));
  });

  it('gives different keys different ids', () => {
    // A collision here is two children sharing an event id, which the server
    // would treat as a replay — so the second child's mark would vanish.
    const keys: string[] = [];
    for (let day = 19; day <= 21; day++) {
      for (const dir of ['pickup', 'drop']) {
        for (let child = 0; child < 400; child++) {
          keys.push(`2026-09-${day}:${dir}:child-${child}`);
        }
      }
    }
    const ids = new Set(keys.map(stableId));
    expect(ids.size).toBe(keys.length);
  });

  it('separates keys that differ only in the last character', () => {
    expect(stableId('2026-09-20:pickup:child-1'))
      .not.toBe(stableId('2026-09-20:pickup:child-2'));
  });
});

describe('where a person lands', () => {
  it('sends a driver to the bus', () => {
    expect(homeFor(['TRANSPORT'])).toBe('/bus');
  });

  it('sends a teacher to the register', () => {
    expect(homeFor(['TEACHER'])).toBe('/');
  });

  it('sends somebody who does both to the register', () => {
    // The register is reachable from the bus screen; a driver stuck on the
    // register has no way to the manifest. When in doubt, land on the screen
    // that leads to the other one.
    expect(homeFor(['TEACHER', 'TRANSPORT'])).toBe('/');
  });

  it('does not strand a role it has never heard of', () => {
    // A guardian signing in today has no screen of their own — that is M21.
    // What they must not get is a blank route.
    expect(homeFor(['GUARDIAN'])).toBe('/');
    expect(homeFor([])).toBe('/');
  });
});
