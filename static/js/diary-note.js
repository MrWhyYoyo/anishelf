// Watch diary: the small "how was it?" editor (a one-line reaction plus a mood).
// Used by the detail page, the "Finished! Moved to Done" moment in main.js and the #/diary page.
import { api } from './api.js';
import { html, setHTML, toast } from './ui.js';

export const MOODS = ['hyped', 'moved', 'cozy', 'mind-blown', 'meh'];
export const MOOD_LABELS = {
  hyped: 'Hyped',
  moved: 'Moved',
  cozy: 'Cozy',
  'mind-blown': 'Mind-blown',
  meh: 'Meh',
};
export const MAX_TEXT = 280;

/** The mood as a small text mark (no emoji, no colour: it's a label). */
export function moodMark(mood) {
  return mood && MOOD_LABELS[mood] ? html`<span class="mood-mark">${MOOD_LABELS[mood]}</span>` : '';
}

/**
 * Open the editor. Saves through the API and resolves to the saved note, or null when skipped.
 * opts: { malId, animeTitle, note (an existing note to edit), heading, intro, skipLabel }
 */
export function openDiaryEditor({ malId, animeTitle = '', note = null, heading = '', intro = '', skipLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let mood = note ? note.mood : null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHTML(overlay, html`<form class="modal diary-modal" role="dialog" aria-modal="true" aria-labelledby="diary-title" autocomplete="off">
      <h3 id="diary-title">${heading || (note ? 'Edit diary note' : 'Add to your watch diary')}</h3>
      <p class="modal-body">${intro || animeTitle}</p>
      <label class="field diary-field"><span>One line about it</span>
        <textarea name="text" rows="2" maxlength="${MAX_TEXT}" placeholder="That ending, though…">${note ? note.text : ''}</textarea>
        <small class="diary-count faint" aria-live="polite"></small>
      </label>
      <div class="field"><span id="diary-mood-label">Mood</span>
        <div class="mood-picker" role="group" aria-labelledby="diary-mood-label">
          ${MOODS.map((m) => html`<button type="button" class="mood-option" data-mood="${m}">${MOOD_LABELS[m]}</button>`)}
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-skip>${skipLabel}</button>
        <button type="submit" class="btn btn-primary" data-save>Save</button>
      </div>
    </form>`);

    const form = overlay.querySelector('form');
    const textarea = form.querySelector('textarea');
    const counter = form.querySelector('.diary-count');
    const saveBtn = form.querySelector('[data-save]');
    const previousFocus = document.activeElement;

    function drawMood() {
      form.querySelectorAll('[data-mood]').forEach((b) => {
        const on = b.dataset.mood === mood;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function drawCount() {
      const left = MAX_TEXT - textarea.value.length;
      counter.textContent = `${left} characters left`;
    }

    let finished = false;
    function finish(value) {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) previousFocus.focus();
      resolve(value);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Enter' && event.target === textarea && !event.shiftKey) {
        // It's a one-liner: Enter saves (Shift+Enter still makes a new line)
        event.preventDefault();
        form.requestSubmit();
      }
    }
    const onHash = () => finish(null);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-skip]')) { finish(null); return; }
      const moodBtn = event.target.closest('[data-mood]');
      if (moodBtn) {
        // Clicking the chosen mood again clears it
        mood = mood === moodBtn.dataset.mood ? null : moodBtn.dataset.mood;
        drawMood();
      }
    });
    textarea.addEventListener('input', drawCount);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text && !mood) {
        toast('Write a line or pick a mood', 'error');
        textarea.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const { note: saved } = note
          ? await api.patchDiary(note.id, { text, mood })
          : await api.addDiary({ mal_id: malId, text, mood });
        toast(note ? 'Diary note updated' : 'Saved to your diary', 'success', 2200);
        finish(saved);
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false;
      }
    });

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(overlay);
    drawMood();
    drawCount();
    requestAnimationFrame(() => overlay.classList.add('show'));
    textarea.focus();
  });
}

/** The prompt shown right after a show is finished (or a rewatch ends). */
export function askForDiary({ malId, animeTitle, rewatch = null }) {
  return openDiaryEditor({
    malId,
    animeTitle,
    heading: rewatch ? `Rewatch #${rewatch} done. How was it?` : 'Finished! How was it?',
    intro: animeTitle ? `A line for your watch diary about ${animeTitle}.` : 'A line for your watch diary.',
    skipLabel: 'Skip',
  });
}
