import { describe, expect, it } from 'vitest';
import { parseReading, startupMenu, type StartupTaskState } from './startup-task';

const menu = (task: StartupTaskState, registry: number | null = null) =>
  startupMenu({ task, registry });

describe('startupMenu', () => {
  it('ticks and lets you untick an enabled task', () => {
    expect(menu('Enabled')).toEqual({ checked: true, enabled: true, onClick: 'disable' });
  });

  it('lets the app turn its own disabled task back on', () => {
    expect(menu('Disabled')).toEqual({ checked: false, enabled: true, onClick: 'enable' });
  });

  it('sends you to Settings when the user turned it off in Windows', () => {
    expect(menu('DisabledByUser')).toEqual({
      checked: false,
      enabled: true,
      onClick: 'open-settings',
    });
  });

  it('trusts WinRT over the registry when WinRT has a real answer', () => {
    expect(menu('Disabled', 2)).toMatchObject({ checked: false, onClick: 'enable' });
    expect(menu('Enabled', 0)).toMatchObject({ checked: true, onClick: 'disable' });
  });

  it('greys out a task an administrator turned on', () => {
    expect(menu('EnabledByPolicy')).toMatchObject({ checked: true, enabled: false });
  });

  describe('when WinRT says DisabledByPolicy (as a sideloaded build is told)', () => {
    it('shows the state Windows shows, and changes it in Settings', () => {
      expect(menu('DisabledByPolicy', 2)).toEqual({
        checked: true,
        enabled: true,
        onClick: 'open-settings',
      });
      expect(menu('DisabledByPolicy', 0)).toMatchObject({ checked: false, enabled: true });
      expect(menu('DisabledByPolicy', null)).toMatchObject({ checked: false, enabled: true });
    });
  });

  it('greys out a task it could not read at all', () => {
    expect(menu('unknown')).toMatchObject({ checked: false, enabled: false });
  });
});

describe('parseReading', () => {
  it('reads the WinRT state and the registry value', () => {
    expect(parseReading('Enabled 2\r\n')).toEqual({ task: 'Enabled', registry: 2 });
    expect(parseReading('DisabledByPolicy none')).toEqual({
      task: 'DisabledByPolicy',
      registry: null,
    });
  });

  it('copes with a missing registry value', () => {
    expect(parseReading('Disabled')).toEqual({ task: 'Disabled', registry: null });
  });

  it('is unknown for anything else', () => {
    expect(parseReading('')).toEqual({ task: 'unknown', registry: null });
    expect(parseReading('Element not found.')).toMatchObject({ task: 'unknown' });
  });
});
