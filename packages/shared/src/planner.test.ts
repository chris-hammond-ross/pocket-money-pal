import { describe, expect, it } from 'vitest';
import {
  basePointsOnDay,
  editorHourLabels,
  editorSpan,
  markerToDrag,
  moveMarker,
  periodOf,
  shiftWindow,
  spanPercent,
  weekDates,
  weeklyBasePoints,
} from './planner';

const times = (bonusBefore: string, dueBy: string, lateAfter: string) => ({
  bonusBefore,
  dueBy,
  lateAfter,
});

describe('weekDates', () => {
  it('runs Monday to Sunday around the date', () => {
    expect(weekDates('2026-10-01')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('keeps a Sunday in the week that started the Monday before', () => {
    expect(weekDates('2026-10-04')[0]).toBe('2026-09-28');
    expect(weekDates('2026-09-28')[6]).toBe('2026-10-04');
  });
});

describe('editorSpan', () => {
  it('pads 90 minutes each side, rounded out to the hour', () => {
    // 07:45 − 90 = 06:15 → 6am; 12:00 + 90 = 13:30 → 2pm.
    expect(editorSpan(times('07:45', '09:00', '12:00'))).toEqual({ start: 6 * 60, end: 14 * 60 });
  });

  it('is at least 5 hours wide', () => {
    // 16:00 − 90 → 2pm; 16:30 + 90 = 18:00 → 6pm, only 4 hours, so it runs to 7pm.
    expect(editorSpan(times('16:00', '16:15', '16:30'))).toEqual({ start: 14 * 60, end: 19 * 60 });
  });

  it('never goes outside 5am–11pm, and stays 5 hours wide near the ends', () => {
    expect(editorSpan(times('05:00', '05:30', '06:00'))).toEqual({ start: 5 * 60, end: 10 * 60 });
    expect(editorSpan(times('22:00', '22:30', '23:00'))).toEqual({ start: 18 * 60, end: 23 * 60 });
    expect(editorSpan(times('05:00', '12:00', '23:00'))).toEqual({ start: 5 * 60, end: 23 * 60 });
  });
});

describe('editorHourLabels', () => {
  it('labels every hour up to 8 hours, then every other hour', () => {
    expect(editorHourLabels({ start: 6 * 60, end: 14 * 60 })).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(editorHourLabels({ start: 6 * 60, end: 15 * 60 })).toEqual([6, 8, 10, 12, 14]);
  });
});

describe('moveMarker', () => {
  const t = times('08:00', '09:00', '12:00');
  const span = editorSpan(t); // 6am–2pm

  it('snaps to 15 minutes', () => {
    expect(moveMarker(t, 'dueBy', 9 * 60 + 22, span).dueBy).toBe('09:15');
    expect(moveMarker(t, 'dueBy', 9 * 60 + 23, span).dueBy).toBe('09:30');
  });

  it('never passes its neighbours, but may meet them', () => {
    expect(moveMarker(t, 'bonusBefore', 10 * 60, span).bonusBefore).toBe('09:00');
    expect(moveMarker(t, 'dueBy', 7 * 60, span).dueBy).toBe('08:00');
    expect(moveMarker(t, 'dueBy', 13 * 60, span).dueBy).toBe('12:00');
    expect(moveMarker(t, 'lateAfter', 8 * 60, span).lateAfter).toBe('09:00');
  });

  it('stays on the bar, and leaves the other markers alone', () => {
    expect(moveMarker(t, 'bonusBefore', 2 * 60, span)).toEqual(times('06:00', '09:00', '12:00'));
    expect(moveMarker(t, 'lateAfter', 20 * 60, span)).toEqual(times('08:00', '09:00', '14:00'));
  });
});

describe('spanPercent', () => {
  it('places times on the bar, clamped', () => {
    const span = { start: 600, end: 900 };
    expect(spanPercent(span, 750)).toBe(50);
    expect(spanPercent(span, 0)).toBe(0);
    expect(spanPercent(span, 1000)).toBe(100);
  });
});

describe('weekly totals', () => {
  const chores = [
    { basePoints: 5, childIds: [1, 2], days: ['mon', 'tue'] as const, oneOffDate: null },
    { basePoints: 10, childIds: [1], days: ['mon'] as const, oneOffDate: null },
    { basePoints: 50, childIds: [1], days: [] as const, oneOffDate: '2026-09-28' },
  ].map((c) => ({ ...c, days: [...c.days] }));

  it('adds base points per weekday across children, leaving one-offs out', () => {
    expect(basePointsOnDay(chores, 'mon')).toBe(20);
    expect(basePointsOnDay(chores, 'tue')).toBe(10);
    expect(basePointsOnDay(chores, 'sun')).toBe(0);
  });

  it("adds a child's recurring base points over the week", () => {
    expect(weeklyBasePoints(chores, 1)).toBe(20);
    expect(weeklyBasePoints(chores, 2)).toBe(10);
    expect(weeklyBasePoints(chores, 3)).toBe(0);
  });
});

describe('markerToDrag', () => {
  const same = times('08:00', '09:00', '09:00');
  it('keeps the marker when it is free to move', () => {
    expect(markerToDrag(times('08:00', '09:00', '12:00'), 'dueBy', 8 * 60 + 30)).toBe('dueBy');
  });

  it('passes the drag to an equal neighbour in the direction of travel', () => {
    expect(markerToDrag(same, 'lateAfter', 8 * 60 + 30)).toBe('dueBy');
    expect(markerToDrag(same, 'dueBy', 10 * 60)).toBe('lateAfter');
    const all = times('09:00', '09:00', '09:00');
    expect(markerToDrag(all, 'lateAfter', 8 * 60)).toBe('bonusBefore');
    expect(markerToDrag(all, 'bonusBefore', 10 * 60)).toBe('lateAfter');
  });
});

describe('shiftWindow', () => {
  it('moves the whole window so the due marker lands on the time, keeping the gaps', () => {
    expect(shiftWindow(times('17:00', '18:00', '19:00'), 8 * 60)).toEqual(
      times('07:00', '08:00', '09:00'),
    );
  });

  it('stops short of 5am and 11pm', () => {
    expect(shiftWindow(times('06:00', '08:00', '10:00'), 6 * 60)).toEqual(
      times('05:00', '07:00', '09:00'),
    );
    expect(shiftWindow(times('17:00', '18:00', '21:00'), 22 * 60)).toEqual(
      times('19:00', '20:00', '23:00'),
    );
  });
});

describe('periodOf', () => {
  it('picks the part of the day the due marker falls in', () => {
    expect(periodOf(times('07:00', '08:00', '09:00')).key).toBe('morning');
    expect(periodOf(times('12:00', '12:30', '13:00')).key).toBe('midday');
    expect(periodOf(times('15:00', '16:00', '17:00')).key).toBe('afternoon');
    expect(periodOf(times('17:00', '18:00', '19:00')).key).toBe('evening');
  });
});
