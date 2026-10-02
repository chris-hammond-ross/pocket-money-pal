/**
 * The chore library (spec 003): suggested quests offered in setup and "+ New quest".
 * Shipped with the app. Times are "HH:MM" in the family time zone; points are whole numbers.
 */
import { WEEKDAYS, type Weekday } from './time';

export const LIBRARY_SECTIONS = ['Morning', 'After school', 'Evening', 'Weekend'] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];

export interface ChoreLibraryItem {
  /** Stable slug, so the app can tell which suggestions a family already has. */
  id: string;
  title: string;
  icon: string;
  section: LibrarySection;
  /** Suggested minimum age. Younger players can still be given it (setup dims the tile). */
  minAge: number;
  bonusBefore: string;
  dueBy: string;
  lateAfter: string;
  basePoints: number;
  earlyBonus: number;
  unpromptedBonus: number;
  latePenalty: number;
  days: readonly Weekday[];
}

const DAILY = WEEKDAYS;
const SCHOOL_DAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

// id, title, icon, section, minAge, bonusBefore, dueBy, lateAfter, base, early, unprompted, late, days
// prettier-ignore
const ROWS = [
  ['make-bed',          'Make your bed',              '🛏️', 'Morning',      4,  '08:00', '09:00', '12:00',  5, 3, 2, 2, DAILY],
  ['dressed-teeth',     'Get dressed & teeth brushed', '🪥', 'Morning',      4,  '07:45', '08:15', '08:30',  5, 2, 2, 2, SCHOOL_DAYS],
  ['feed-pet',          'Feed the cat',               '🐈', 'Morning',      6,  '07:45', '08:15', '09:00',  5, 2, 3, 5, DAILY],
  ['pack-bag',          'Pack school bag',            '🎒', 'Morning',      6,  '07:30', '08:00', '08:15',  5, 2, 3, 2, SCHOOL_DAYS],
  ['reading',           'Homework reading (20 min)',  '📚', 'After school', 6,  '17:00', '19:00', '20:00', 10, 5, 5, 2, SCHOOL_DAYS],
  ['instrument',        'Practise instrument',        '🎹', 'After school', 7,  '17:30', '18:30', '19:30', 10, 3, 5, 2, ['mon', 'wed', 'fri']],
  ['empty-dishwasher',  'Empty the dishwasher',       '🍽️', 'After school', 8,  '16:30', '17:30', '19:00', 15, 5, 5, 5, ['mon', 'wed', 'fri']],
  ['water-plants',      'Water the plants',           '🪴', 'After school', 5,  '16:00', '18:00', '20:00',  5, 2, 3, 1, ['tue', 'thu', 'sat']],
  ['tidy-bedroom',      'Tidy bedroom',               '🧸', 'After school', 4,  '17:00', '18:30', '19:30', 10, 5, 5, 3, DAILY],
  ['set-table',         'Set the table',              '🍴', 'Evening',      5,  '17:45', '18:00', '18:15',  5, 2, 3, 2, DAILY],
  ['clear-table',       'Clear the table',            '🧽', 'Evening',      5,  '18:45', '19:00', '19:30',  5, 2, 3, 2, DAILY],
  ['bins',              'Take the bins out',          '🗑️', 'Evening',      9,  '18:00', '19:00', '20:30', 10, 3, 5, 3, ['sun']],
  ['laundry',           'Put laundry away',           '👕', 'Evening',      6,  '18:00', '19:30', '20:00', 10, 3, 3, 2, ['tue', 'fri']],
  ['hoover-stairs',     'Hoover the stairs',          '🧹', 'Weekend',      9,  '11:00', '13:00', '17:00', 20, 5, 5, 5, ['sat']],
  ['wash-car',          'Wash the car',               '🚗', 'Weekend',      8,  '12:00', '15:00', '18:00', 25, 5, 5, 5, ['sun']],
  ['walk-dog',          'Walk the dog',               '🐕', 'Weekend',      9,  '10:00', '12:00', '14:00', 10, 3, 5, 3, ['sat', 'sun']],
] as const;

export const CHORE_LIBRARY: readonly ChoreLibraryItem[] = ROWS.map(
  ([
    id,
    title,
    icon,
    section,
    minAge,
    bonusBefore,
    dueBy,
    lateAfter,
    base,
    early,
    unprompted,
    late,
    days,
  ]) => ({
    id,
    title,
    icon,
    section,
    minAge,
    bonusBefore,
    dueBy,
    lateAfter,
    basePoints: base,
    earlyBonus: early,
    unpromptedBonus: unprompted,
    latePenalty: late,
    days,
  }),
);
