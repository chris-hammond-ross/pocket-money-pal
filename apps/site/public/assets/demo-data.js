// The hero demo's data: the bits of prototypes/_shared/mock-data.js it uses (Billy, Alice, their chores,
// the basketball goal), copied unchanged. Plain script: exposes window.PMP.
window.PMP = {
  settings: {
    currency: 'GBP',
    currencySymbol: '£',
    centsPerPoint: 5, // 20 points = £1.00
    timezone: 'Europe/London',
  },

  children: [
    { id: 'c1', name: 'Billy', age: 10, colour: '#228be6', avatar: '🦖', streakDays: 4, pointsThisWeek: 85, savingsCents: 4250 },
    { id: 'c2', name: 'Alice', age: 8, colour: '#e64980', avatar: '🦄', streakDays: 7, pointsThisWeek: 110, savingsCents: 1875 },
  ],

  chores: [
    { id: 'ch1', title: 'Make your bed', icon: '🛏️', basePoints: 5, bonusBefore: '08:00', dueBy: '09:00', lateAfter: '12:00', earlyBonus: 3, unpromptedBonus: 2, latePenalty: 2, assignees: ['c1', 'c2'], shared: false, days: 'daily' },
    { id: 'ch2', title: 'Tidy shared bedroom', icon: '🧸', basePoints: 10, bonusBefore: '17:00', dueBy: '18:30', lateAfter: '19:30', earlyBonus: 5, unpromptedBonus: 5, latePenalty: 3, assignees: ['c1', 'c2'], shared: true, days: 'daily' },
    { id: 'ch3', title: 'Feed the cat', icon: '🐈', basePoints: 5, bonusBefore: '07:45', dueBy: '08:15', lateAfter: '09:00', earlyBonus: 2, unpromptedBonus: 3, latePenalty: 5, assignees: ['c1'], shared: false, days: 'daily' },
    { id: 'ch4', title: 'Empty the dishwasher', icon: '🍽️', basePoints: 15, bonusBefore: '16:30', dueBy: '17:30', lateAfter: '19:00', earlyBonus: 5, unpromptedBonus: 5, latePenalty: 5, assignees: ['c1'], shared: false, days: ['mon', 'wed', 'fri'] },
    { id: 'ch6', title: 'Homework reading (20 min)', icon: '📚', basePoints: 10, bonusBefore: '17:00', dueBy: '19:00', lateAfter: '20:00', earlyBonus: 5, unpromptedBonus: 5, latePenalty: 2, assignees: ['c1', 'c2'], shared: false, days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  ],

  goals: [
    { id: 'g2', childId: 'c1', name: 'Basketball', targetCents: 2499, term: 'short', emoji: '🏀', priority: 2, createdBy: 'c1', createdOn: '2026-09-10' },
  ],
};
