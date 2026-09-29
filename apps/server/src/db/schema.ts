import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const timestamps = {
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
};

/** Single-row table (id = 1) holding family-wide configuration. */
export const familySettings = sqliteTable('family_settings', {
  id: integer('id').primaryKey(),
  familyName: text('family_name').notNull().default('Our Family'),
  currency: text('currency').notNull().default('GBP'),
  /** Integer cents earned per point. */
  centsPerPoint: integer('cents_per_point').notNull().default(5),
  timezone: text('timezone').notNull().default('Europe/London'),
  ...timestamps,
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  role: text('role', { enum: ['parent', 'child'] }).notNull(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  colour: text('colour'),
  /** Hashed PIN; required for parents, optional for children. */
  pinHash: text('pin_hash'),
  /** Left-to-right order of children's kiosk columns. */
  sortOrder: integer('sort_order').notNull().default(0),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
});
