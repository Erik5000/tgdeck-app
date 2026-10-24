import { randomUUID } from 'node:crypto';
import { OperationError } from './errors.ts';
import type { Column, ColumnPosition, Settings, WorkspacePreferences } from './protocol.ts';

export const defaultSettings: Settings = { theme: 'system', accent: 'sage', fontSize: 16,
  profilePictures: false, density: 'comfortable', messageStyle: 'bubbles', layout: 'columns' };
export const defaultPreferences = (): WorkspacePreferences => ({ settings: { ...defaultSettings }, columns: [], layouts: [] });
const choices = {
  theme: ['system', 'light', 'dark'], accent: ['sage', 'ocean', 'rose', 'amber'], fontSize: [12, 14, 16, 18],
  profilePictures: [true, false], density: ['comfortable', 'compact'], messageStyle: ['flat', 'bubbles'], layout: ['columns', 'grid', 'focus'],
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateSettings(value: unknown): asserts value is Settings {
  if (!object(value) || Object.keys(value).length !== Object.keys(choices).length
    || Object.entries(choices).some(([key, options]) => !(options as unknown[]).includes(value[key]))) throw new OperationError('invalidRequest');
}
export function validColumnId(value: unknown): value is string {
  return typeof value === 'string' && (/^demo-[a-z-]{1,40}$/.test(value)
    || /^live--?[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(5))));
}
function positions(value: unknown): value is ColumnPosition[] {
  return Array.isArray(value) && value.length <= 20 && value.every(item => object(item)
    && Object.keys(item).length === 2 && validColumnId(item.id) && typeof item.width === 'string' && ['narrow', 'medium', 'wide'].includes(item.width))
    && new Set(value.map(item => item.id)).size === value.length;
}
export function validatePreferences(value: unknown): asserts value is WorkspacePreferences {
  if (!object(value) || Object.keys(value).length !== 3) throw new OperationError('invalidRequest');
  validateSettings(value.settings);
  if (!positions(value.columns) || !Array.isArray(value.layouts) || value.layouts.length > 12
    || !value.layouts.every(item => object(item) && Object.keys(item).length === 4
      && typeof item.id === 'string' && /^[a-f\d-]{36}$/.test(item.id)
      && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 40
      && choices.layout.includes(item.layout as Settings['layout']) && positions(item.columns))
    || new Set(value.layouts.map(item => item.id)).size !== value.layouts.length) throw new OperationError('invalidRequest');
}
export function arrangeColumns(columns: Column[], preferences: WorkspacePreferences): Column[] {
  const byId = new Map(columns.map(column => [column.id, column]));
  const result: Column[] = [];
  for (const saved of preferences.columns) {
    const column = byId.get(saved.id);
    if (column) { result.push({ ...column, width: saved.width }); byId.delete(saved.id); }
  }
  return [...result, ...byId.values()];
}
export function changeColumn(preferences: WorkspacePreferences, columns: Column[], id: string, value: unknown): WorkspacePreferences {
  if (!object(value) || Object.keys(value).length !== 1) throw new OperationError('invalidRequest');
  const result = structuredClone(preferences);
  const list = arrangeColumns(columns, preferences).map(({ id, width }) => ({ id, width }));
  const index = list.findIndex(column => column.id === id);
  if (index < 0) throw new OperationError('notFound', 404);
  if ('width' in value && typeof value.width === 'string' && ['narrow', 'medium', 'wide'].includes(value.width)) list[index]!.width = value.width as Column['width'];
  else if ('move' in value && (value.move === 'left' || value.move === 'right')) {
    const next = index + (value.move === 'left' ? -1 : 1);
    if (next >= 0 && next < list.length) [list[index], list[next]] = [list[next]!, list[index]!];
  } else if ('beforeId' in value && (value.beforeId === null || validColumnId(value.beforeId))) {
    if (value.beforeId !== null && !list.some(column => column.id === value.beforeId)) throw new OperationError('notFound', 404);
    if (value.beforeId !== id) {
      const [column] = list.splice(index, 1);
      const target = value.beforeId === null ? list.length : list.findIndex(column => column.id === value.beforeId);
      list.splice(target, 0, column!);
    }
  } else throw new OperationError('invalidRequest');
  result.columns = list;
  return result;
}
export function saveLayout(preferences: WorkspacePreferences, columns: Column[], value: unknown): WorkspacePreferences {
  if (!object(value) || Object.keys(value).length !== 1 || typeof value.name !== 'string'
    || !value.name.trim() || value.name.length > 40 || columns.length === 0 || preferences.layouts.length >= 12) throw new OperationError('invalidRequest');
  const result = structuredClone(preferences);
  result.layouts.push({ id: randomUUID(), name: value.name.trim(), layout: result.settings.layout,
    columns: arrangeColumns(columns, preferences).map(({ id, width }) => ({ id, width })) });
  return result;
}
