// @ts-check
/** @import { Column, Settings, Snapshot } from '../src/protocol.ts' */
import { errorText } from './login.js';

/** @param {Settings} settings */
export function applyDisplay(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme;
  root.dataset.accent = settings.accent;
  root.dataset.fontSize = String(settings.fontSize);
  root.dataset.density = settings.density;
  root.dataset.messageStyle = settings.messageStyle;
}

/** @param {{ change: (path: string, method: string, body?: unknown) => Promise<void>; notify: (text: string) => void }} callbacks */
export function initPreferences(callbacks) {
  const dialog = document.createElement('dialog');
  dialog.className = 'preferences-dialog';
  dialog.setAttribute('aria-label', 'Display and layouts');
  const heading = document.createElement('h2');
  heading.textContent = 'Make room for your kind of day.';
  const close = button('×', () => dialog.close());
  close.className = 'dialog-close';
  close.setAttribute('aria-label', 'Close display settings');
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Choose your colors, reading size and arrangement. Save layouts to switch between different boards.';
  const form = document.createElement('form');
  form.className = 'settings-form';
  const fields = document.createElement('div');
  fields.className = 'settings-fields';
  const theme = select('Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
  const accent = select('Accent color', [['sage', 'Sage'], ['ocean', 'Ocean'], ['rose', 'Rose'], ['amber', 'Amber']]);
  const font = select('Font size', [[12, 'Small · 12 px'], [14, 'Medium · 14 px'], [16, 'Large · 16 px'], [18, 'Extra large · 18 px']]);
  const density = select('Message spacing', [['comfortable', 'Comfortable'], ['compact', 'Compact']]);
  const style = select('Message style', [['flat', 'Flat'], ['bubbles', 'Bubbles']]);
  const layout = select('Column arrangement', [['columns', 'Side by side'], ['grid', 'Two-row grid'], ['focus', 'Focus · wide columns']]);
  fields.append(theme.label, accent.label, font.label, density.label, style.label, layout.label);
  const pictureLabel = document.createElement('label');
  pictureLabel.className = 'setting-toggle';
  const pictures = document.createElement('input');
  pictures.type = 'checkbox';
  pictureLabel.append(pictures, document.createTextNode('Show profile pictures'));
  const pictureHint = document.createElement('p');
  pictureHint.className = 'settings-note';
  pictureHint.textContent = 'Loads small pictures from Telegram only when enabled. Initials remain when a picture is unavailable.';
  const apply = button('Apply display settings');
  apply.type = 'submit';
  apply.className = 'button primary';
  form.append(fields, pictureLabel, pictureHint, apply);
  const easyReading = document.getElementById('easy-reading');
  if (easyReading) form.append(easyReading);
  const divider = document.createElement('hr');
  const layoutHeading = document.createElement('h3');
  layoutHeading.textContent = 'Saved layouts';
  const saveForm = document.createElement('form');
  saveForm.className = 'save-layout';
  const name = document.createElement('input');
  name.maxLength = 40;
  name.required = true;
  name.placeholder = 'e.g. Morning overview';
  name.setAttribute('aria-label', 'Layout name');
  const save = button('Save current layout');
  save.type = 'submit';
  save.className = 'button subtle';
  saveForm.append(name, save);
  const saved = document.createElement('div');
  saved.className = 'saved-layouts';
  const hint = document.createElement('p');
  hint.className = 'settings-note';
  hint.textContent = 'Layouts save the chats, order, widths and arrangement. Up to 12 layouts. Switching boards discards drafts in columns that close.';
  const status = document.createElement('p');
  status.className = 'settings-status';
  status.setAttribute('role', 'status');
  dialog.append(close, heading, intro, form, divider, layoutHeading, saveForm, saved, hint, status);
  document.body.append(dialog);
  /** @type {Snapshot | undefined} */
  let latest;
  let dirty = false;
  let busy = false;
  const controls = [theme.input, accent.input, font.input, density.input, style.input, layout.input, pictures];

  /** @returns {Settings} */
  function values() {
    return { theme: /** @type {Settings['theme']} */ (theme.input.value), accent: /** @type {Settings['accent']} */ (accent.input.value),
      fontSize: /** @type {Settings['fontSize']} */ (Number(font.input.value)), profilePictures: pictures.checked,
      density: /** @type {Settings['density']} */ (density.input.value), messageStyle: /** @type {Settings['messageStyle']} */ (style.input.value),
      layout: /** @type {Settings['layout']} */ (layout.input.value) };
  }
  for (const control of controls) control.addEventListener('change', () => { dirty = true; applyDisplay(values()); status.textContent = 'Previewing changes. Apply to save.'; });
  async function perform(/** @type {() => Promise<void>} */ action) {
    if (busy) return;
    busy = true;
    controls.forEach(control => { control.disabled = true; });
    apply.disabled = save.disabled = true;
    status.textContent = '';
    try { await action(); status.textContent = 'Saved.'; }
    catch (error) { status.textContent = errorText(error); callbacks.notify(errorText(error)); }
    finally { busy = false; controls.forEach(control => { control.disabled = false; }); apply.disabled = false; save.disabled = !latest?.columns.length || (latest.layouts?.length ?? 0) >= 12; }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const settings = values();
    void perform(async () => { await callbacks.change('/api/settings', 'PUT', settings); dirty = false; });
  });
  saveForm.addEventListener('submit', event => {
    event.preventDefault();
    const settings = values();
    const layoutName = name.value;
    void perform(async () => {
      await callbacks.change('/api/settings', 'PUT', settings);
      dirty = false;
      await callbacks.change('/api/layouts', 'POST', { name: layoutName });
      name.value = '';
    });
  });
  dialog.addEventListener('close', () => { dirty = false; if (latest?.settings) applyDisplay(latest.settings); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (latest?.settings) applyDisplay(dialog.open && dirty ? values() : latest.settings);
  });

  const columnDialog = document.createElement('dialog');
  columnDialog.className = 'column-dialog';
  columnDialog.setAttribute('aria-label', 'Column options');
  const columnTitle = document.createElement('h2');
  const columnClose = button('×', () => columnDialog.close());
  columnClose.className = 'dialog-close';
  columnClose.setAttribute('aria-label', 'Close column options');
  const width = select('Column width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']]);
  let columnId = '';
  let columnBusy = false;
  async function updateColumn(/** @type {unknown} */ body) {
    if (columnBusy) return;
    columnBusy = true;
    width.input.disabled = left.disabled = right.disabled = true;
    try { await callbacks.change(`/api/columns/${encodeURIComponent(columnId)}`, 'PATCH', body); }
    catch (error) { callbacks.notify(errorText(error)); }
    finally { columnBusy = false; width.input.disabled = false; renderColumn(); }
  }
  const left = button('← Move left', () => { void updateColumn({ move: 'left' }); });
  const right = button('Move right →', () => { void updateColumn({ move: 'right' }); });
  left.className = right.className = 'button subtle';
  const moves = document.createElement('div');
  moves.className = 'column-moves';
  moves.append(left, right);
  const widthHint = document.createElement('p');
  widthHint.className = 'settings-note';
  widthHint.textContent = 'Individual widths apply to Side by side. Grid and Focus fit columns to their arrangement.';
  columnDialog.append(columnClose, columnTitle, width.label, moves, widthHint);
  document.body.append(columnDialog);
  width.input.addEventListener('change', () => { void updateColumn({ width: width.input.value }); });
  function renderColumn() {
    const index = latest?.columns.findIndex(column => column.id === columnId) ?? -1;
    const column = latest?.columns[index];
    if (!column) { if (columnDialog.open) columnDialog.close(); return; }
    columnTitle.textContent = column.title;
    width.input.value = column.width;
    left.disabled = columnBusy || index <= 0;
    right.disabled = columnBusy || index === (latest?.columns.length ?? 0) - 1;
  }
  return {
    reset() { latest = undefined; dirty = false; dialog.close(); columnDialog.close(); saved.replaceChildren(); name.value = ''; columnTitle.textContent = ''; },
    open() { if (!latest?.settings) return; dirty = false; this.render(latest); status.textContent = ''; dialog.showModal(); },
    async easyReading() {
      if (!latest?.settings) return;
      const settings = { ...latest.settings, fontSize: Math.max(16, latest.settings.fontSize), density: 'comfortable' };
      await perform(async () => {
        await callbacks.change('/api/settings', 'PUT', settings);
        callbacks.notify('Easy reading is on: larger text and comfortable spacing.');
      });
    },
    /** @param {Column} column */
    openColumn(column) { columnId = column.id; renderColumn(); columnDialog.showModal(); },
    /** @param {Snapshot} snapshot */
    render(snapshot) {
      latest = snapshot;
      if (!snapshot.settings) return;
      if (!dirty) {
        const s = snapshot.settings;
        theme.input.value = s.theme; accent.input.value = s.accent; font.input.value = String(s.fontSize);
        density.input.value = s.density; style.input.value = s.messageStyle; layout.input.value = s.layout; pictures.checked = s.profilePictures;
        applyDisplay(s);
      }
      save.disabled = busy || !snapshot.columns.length || (snapshot.layouts?.length ?? 0) >= 12;
      saved.replaceChildren();
      for (const item of snapshot.layouts ?? []) {
        const row = document.createElement('div');
        row.className = 'saved-layout';
        const title = document.createElement('span');
        title.textContent = `${item.name} · ${item.columns.length} columns`;
        const use = button('Use', () => { void perform(async () => { await callbacks.change(`/api/layouts/${item.id}/apply`, 'POST'); dirty = false; dialog.close(); }); });
        use.setAttribute('aria-label', `Use ${item.name} layout`);
        const remove = button('Delete', () => { void perform(() => callbacks.change(`/api/layouts/${item.id}`, 'DELETE')); });
        remove.setAttribute('aria-label', `Delete ${item.name} layout`);
        row.append(title, use, remove); saved.append(row);
      }
      renderColumn();
    },
  };
}

/** @param {string} text @param {() => void} [action] */
function button(text, action) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
  if (action) element.addEventListener('click', action);
  return element;
}
/** @param {string} text @param {Array<[string | number, string]>} options */
function select(text, options) {
  const label = document.createElement('label'); label.className = 'setting-field';
  const title = document.createElement('span'); title.textContent = text;
  const input = document.createElement('select');
  for (const [value, text] of options) { const option = document.createElement('option'); option.value = String(value); option.textContent = text; input.append(option); }
  label.append(title, input); return { label, input };
}
