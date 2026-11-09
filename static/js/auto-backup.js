// Settings: "Last automatic backup: <date>" and a "Back up now" button.
// The server writes one backup a day to data/backups/auto and keeps the newest 7
// (see anishelf/autobackup.py). Styles live in css/qol.css.
import { api } from './api.js';
import { html, setHTML, toast } from './ui.js';

function describe(status) {
  if (!status.enabled) return 'Automatic backups are switched off.';
  if (!status.last) return 'Last automatic backup: none yet';
  // "2026-11-09" -> a local date like "9 Nov 2026". Adding T00:00 makes it local time, not UTC.
  const day = new Date(`${status.last.date}T00:00`);
  const pretty = day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `Last automatic backup: ${pretty} (keeps the newest ${status.keep})`;
}

/** Fill `container` with the status line and the button. */
export function mountAutoBackup(container) {
  if (!container) return;
  setHTML(container, html`<span class="auto-backup-text" id="auto-backup-text">Checking automatic backups…</span>
    <button type="button" class="btn btn-sm" id="auto-backup-now">Back up now</button>`);
  const text = container.querySelector('#auto-backup-text');
  const button = container.querySelector('#auto-backup-now');

  const show = (status) => {
    if (!text.isConnected) return;
    text.textContent = describe(status);
    text.title = status.folder ? `Saved in ${status.folder}` : '';
    button.hidden = !status.enabled;
  };

  api.autoBackup().then(show).catch(() => { if (text.isConnected) text.textContent = 'Last automatic backup: unknown'; });

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      show(await api.autoBackupNow());
      toast('Backup saved', 'success', 2200);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
