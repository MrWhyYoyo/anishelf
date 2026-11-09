import { api } from '../api.js';
import {
  html, raw, setHTML, toast, confirmDialog, icon, plural, getTitleLanguage, setTitleLanguage,
} from '../ui.js';
import { THEMES, getTheme, setTheme } from '../theme.js';
import {
  stickerHtml, getBuddySettings, setBuddySettings, buddyPrefersReducedMotion, resolveBuddyCharacter,
} from '../buddy.js';
import { openAvatarPicker } from '../avatar.js';
import { mountAutoBackup } from '../auto-backup.js';
import {
  getSoundSettings, setSoundSettings, playSound, soundSupported, prefersQuiet,
} from '../sound.js';
import { getFeel, setFeel } from '../feel.js';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
// Progress-related keys only; UI preferences (title language, views, cast language) are kept.
const PROGRESS_KEYS = ['anishelf.progress', 'anishelf.pendingWatch'];

/** "Type RESET to confirm" dialog. Resolves true once the server confirmed the reset. */
function openResetDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  setHTML(overlay, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
    <h3 id="reset-title">Reset everything?</h3>
    <div class="modal-body">
      <p>This permanently deletes your library, watch history, scores, rankings, XP and profile.</p>
      <label class="field" style="margin-top:14px"><span>Type RESET to confirm</span>
        <input type="text" id="reset-input" autocomplete="off" spellcheck="false" placeholder="RESET">
      </label>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="button" class="btn btn-danger" data-confirm disabled>Reset everything</button>
    </div>
  </div>`);
  const input = overlay.querySelector('#reset-input');
  const confirmBtn = overlay.querySelector('[data-confirm]');
  const previousFocus = document.activeElement;
  let busy = false;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && document.activeElement === input && !confirmBtn.disabled) { event.preventDefault(); doReset(); }
  };

  async function doReset() {
    if (busy || input.value !== 'RESET') return;
    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Resetting…';
    try {
      await api.reset();
      PROGRESS_KEYS.forEach((key) => { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } });
      close();
      toast('Fresh start', 'success');
      window.dispatchEvent(new CustomEvent('anishelf:reset'));
      if (window.location.hash === '#/' || window.location.hash === '') window.dispatchEvent(new CustomEvent('anishelf:rerender'));
      else window.location.hash = '#/';
    } catch (err) {
      busy = false;
      confirmBtn.textContent = 'Reset everything';
      confirmBtn.disabled = input.value !== 'RESET';
      toast(err.message, 'error');
    }
  }

  input.addEventListener('input', () => { confirmBtn.disabled = busy || input.value !== 'RESET'; });
  overlay.addEventListener('click', (event) => {
    if (busy) return;
    if (event.target === overlay || event.target.closest('[data-cancel]')) close();
    else if (event.target.closest('[data-confirm]')) doReset();
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  input.focus();
}

export function render(root) {
  setHTML(root, html`
    <header class="page-head"><h1>Settings</h1><p>Look and sound, backups, data and a little about AniShelf.</p></header>
    <div class="settings-grid">
      <section class="panel">
        <h2>Anime titles</h2>
        <p>Show titles in English when there is an official English title, or always in Japanese (romaji).</p>
        <div class="segmented" id="title-lang" role="group" aria-label="Anime title language">
          <button type="button" data-lang="english">English</button>
          <button type="button" data-lang="romaji">Japanese (romaji)</button>
        </div>
      </section>

      <section class="panel settings-wide">
        <h2>Theme</h2>
        <p>The background greys. Each anime keeps its own colour on progress and episodes. Saved on this device.</p>
        <div class="theme-options" id="theme-options" role="group" aria-label="Colour theme">
          ${THEMES.map((t) => html`<button type="button" class="theme-option" data-theme-id="${t.id}" title="${t.text}">
            <span class="theme-swatch" aria-hidden="true">
              <span style="background:${t.swatch[0]};color:${t.swatch[3]}">Aa</span>
              <span style="background:${t.swatch[1]}"></span>
              <span style="background:${t.swatch[2]}"></span>
            </span>
            <span class="theme-option-name">${t.name}<span class="theme-option-current">Current</span></span>
          </button>`)}
        </div>
      </section>

      <section class="panel settings-wide">
        <h2>Buddy</h2>
        <p>A character from your shows hangs around the bottom edge as a little sticker. It moves out of your way when your mouse comes close, naps when you're away, cheers when you mark episodes and hides during mini games. Click it to pet it, or drag it somewhere else. Saved on this device.</p>
        <div class="buddy-picks" id="buddy-picks" role="group" aria-label="Choose a buddy"></div>
        <p class="faint small" id="buddy-hint" style="margin:10px 0 0" hidden></p>
        <div class="buddy-row">
          <span>Let it talk</span>
          <div class="segmented" id="buddy-talk" role="group" aria-label="Let the buddy talk">
            <button type="button" data-talk="off">Off</button>
            <button type="button" data-talk="on">On</button>
          </div>
        </div>
        <p class="faint small" id="buddy-note" style="margin:10px 0 0"></p>
      </section>

      <section class="panel">
        <h2>Sound effects</h2>
        <p>Quiet little sounds for +1 episode, level-ups, badges and new game bests. Off unless you turn them on. Saved on this device.</p>
        <div class="sound-row">
          <div class="segmented" id="sound-toggle" role="group" aria-label="Sound effects">
            <button type="button" data-sound="off">Off</button>
            <button type="button" data-sound="on">On</button>
          </div>
          <label class="sound-row" style="margin:0">
            <span class="muted small">Volume</span>
            <input type="range" id="sound-volume" min="0" max="100" step="5" aria-label="Sound volume">
          </label>
          <button type="button" class="btn btn-sm" id="sound-test">Test</button>
        </div>
        <p class="faint small" id="sound-note" style="margin-top:10px"></p>
      </section>

      <section class="panel">
        <h2>Feel</h2>
        <p>How much the app reacts when you click: ripples, a spinner while it saves, a little ✓ when it's done, and pages that slide in. "Calm" keeps it still. Saved on this device.</p>
        <div class="sound-row">
          <div class="segmented" id="feel-motion" role="group" aria-label="Motion">
            <button type="button" data-motion="lively">Lively</button>
            <button type="button" data-motion="calm">Calm</button>
          </div>
          <label class="check"><input type="checkbox" id="feel-clicks"> Click sounds</label>
        </div>
        <p class="faint small" id="feel-note" style="margin-top:10px"></p>
      </section>

      <section class="panel">
        <h2>Back up your shelf</h2>
        <p>Download everything (statuses, episodes, scores, tiers and journal notes) as one JSON file. Keep it somewhere safe (or copy it to your Mac).</p>
        <a class="btn btn-primary" href="/api/export" download>${icon('download')} Export backup</a>
        <div class="auto-backup" id="auto-backup"></div>
      </section>

      <section class="panel">
        <h2>Restore a backup</h2>
        <p>Import a backup file made with Export. Anime in the file are added to your library or update the matching ones.</p>
        <label class="btn file-label">${icon('upload')} Choose backup file…
          <input type="file" id="import-file" accept="application/json,.json">
        </label>
        <p class="small" id="import-status" style="margin:12px 0 0"></p>
      </section>

      <section class="panel">
        <h2>Keyboard shortcuts</h2>
        <div class="shortcuts" style="margin-top:14px">
          <span class="kbd">/</span><span>Jump to search</span>
          <span class="kbd">Ctrl K</span><span>Quick jump to an anime or page (Shift+Enter marks +1)</span>
          <span class="kbd">Shift</span><span>+ click an episode to mark a range</span>
          <span class="kbd">← →</span><span>Pick a winner in Versus</span>
          <span class="kbd">Esc</span><span>Close menus and dialogs</span>
        </div>
      </section>

      <section class="panel">
        <h2>About AniShelf</h2>
        <p>A personal anime tracker. Anime info and cover art come from <strong>Jikan</strong> (an unofficial MyAnimeList API) and banners &amp; colours from <strong>AniList</strong>. Both are free and need no API keys, so nothing here can ever cost money.</p>
        <p>Your data lives only on this computer, in the app's local database. Images are cached on disk so they load instantly next time.</p>
        <p class="faint small" id="version">Checking version…</p>
      </section>
    </div>

    <section class="panel danger-zone">
      <div class="danger-text">
        <h2>Danger zone</h2>
        <p>Reset everything: deletes your library, watch history, scores, rankings, XP and profile. Anime info and images stay cached. This can't be undone.</p>
      </div>
      <div class="danger-actions">
        <a class="btn" href="/api/export" download>${icon('download')} Download a backup first</a>
        <button type="button" class="btn btn-danger" id="reset-btn">${icon('trash')} Reset everything</button>
      </div>
    </section>
  `);

  /* ---------------------------------------------------------------- title language */
  const langEl = root.querySelector('#title-lang');
  function drawLang() {
    const lang = getTitleLanguage();
    langEl.querySelectorAll('[data-lang]').forEach((b) => {
      const active = b.dataset.lang === lang;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  drawLang();
  langEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-lang]');
    if (!button || button.dataset.lang === getTitleLanguage()) return;
    const previous = getTitleLanguage();
    setTitleLanguage(button.dataset.lang);
    drawLang();
    try {
      await api.patchMe({ title_language: button.dataset.lang });
      toast(button.dataset.lang === 'english' ? 'Showing English titles' : 'Showing Japanese (romaji) titles', 'success', 2200);
      window.dispatchEvent(new CustomEvent('anishelf:rerender'));
    } catch (err) {
      setTitleLanguage(previous);
      drawLang();
      toast(err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------- theme */
  const themeEl = root.querySelector('#theme-options');
  function drawTheme() {
    const current = getTheme();
    themeEl.querySelectorAll('[data-theme-id]').forEach((b) => {
      const active = b.dataset.themeId === current;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  drawTheme();
  themeEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-id]');
    if (!button) return;
    setTheme(button.dataset.themeId); // applies straight away, no reload needed
    drawTheme();
  });

  /* ---------------------------------------------------------------- buddy */
  // The previews animate with plain CSS, so they need no code and stop when you leave Settings.
  // The cards are drawn after asking which character the buddy really uses (your pick, or your
  // profile avatar when you haven't picked one), because that answer may need the server.
  const picksEl = root.querySelector('#buddy-picks');
  const talkEl = root.querySelector('#buddy-talk');
  const buddyNote = root.querySelector('#buddy-note');
  const buddyHint = root.querySelector('#buddy-hint');
  async function drawBuddyCards() {
    const { kind } = getBuddySettings();
    const character = await resolveBuddyCharacter();
    if (!root.isConnected) return;
    const card = (key, active, preview, name, from) => html`<button type="button" class="buddy-pick ${active ? 'active' : ''}"
      data-buddy="${key}" aria-pressed="${active ? 'true' : 'false'}">
      <span class="buddy-preview ${preview ? '' : 'is-none'}" aria-hidden="true">${preview || name}</span>
      <span class="buddy-pick-name">${name}</span>
      <span class="buddy-pick-from">${from}</span>
    </button>`;
    setHTML(picksEl, html`
      ${character ? card('current', true, raw(stickerHtml(character)), character.name,
        kind === 'default' ? 'Your profile avatar' : (character.anime || 'Your pick')) : ''}
      ${card('choose', false, html`<span class="buddy-pick-plus">+</span>`, character ? 'Change character' : 'Choose a character', 'From your shows, or search')}
      ${card('none', !character, '', 'None', 'No buddy')}`);
    buddyHint.hidden = !(kind === 'default' && !character);
    buddyHint.textContent = 'Pick a character from your shows to get a buddy.';
  }
  async function chooseBuddy() {
    const { kind, character } = getBuddySettings();
    await openAvatarPicker(kind === 'character' ? character : null, {
      title: 'Choose your buddy',
      startTab: 'library',
      removeLabel: 'No buddy',
      emptyLabel: 'No character selected',
      onSave: async (picked) => {
        if (picked) {
          setBuddySettings({ character: { id: picked.id, name: picked.name, image: picked.image, anime: picked.anime || '' } });
          toast(`${picked.name} is your buddy now`, 'success');
        } else {
          setBuddySettings({ kind: 'none' });
          toast('Buddy turned off', 'success');
        }
        return picked;
      },
    });
    drawBuddyCards();
  }
  function drawBuddy() {
    const { talk } = getBuddySettings();
    talkEl.querySelectorAll('[data-talk]').forEach((b) => {
      const active = (b.dataset.talk === 'on') === talk;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    buddyNote.textContent = buddyPrefersReducedMotion()
      ? 'Your system asks for reduced motion, so the buddy stands still and just fades when your mouse comes near.'
      : '';
  }
  drawBuddy();
  drawBuddyCards();
  picksEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-buddy]');
    if (!button) return;
    if (button.dataset.buddy === 'none') {
      setBuddySettings({ kind: 'none' }); // saves and updates the buddy live
      drawBuddyCards();
    } else {
      chooseBuddy(); // the current card and "Choose a character" both open the picker
    }
  });
  talkEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-talk]');
    if (!button) return;
    setBuddySettings({ talk: button.dataset.talk === 'on' });
    drawBuddy();
  });

  /* ---------------------------------------------------------------- sound effects */
  // ---- Feel (1.2.1): motion level + click sounds, see feel.js
  const feelMotion = root.querySelector('#feel-motion');
  const feelClicks = root.querySelector('#feel-clicks');
  const feelNote = root.querySelector('#feel-note');
  function drawFeel() {
    const feel = getFeel();
    feelMotion.querySelectorAll('[data-motion]').forEach((b) => {
      const on = b.dataset.motion === feel.motion;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    feelClicks.checked = feel.clicks;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const soundOff = !getSoundSettings().on;
    feelNote.textContent = [
      reduced ? 'Windows is set to reduce animations, so the moving parts stay off either way.' : '',
      feel.clicks && soundOff ? 'Click sounds need Sound effects turned on above.' : '',
    ].filter(Boolean).join(' ');
  }
  feelMotion.addEventListener('click', (event) => {
    const button = event.target.closest('[data-motion]');
    if (!button) return;
    setFeel({ motion: button.dataset.motion });
    drawFeel();
  });
  feelClicks.addEventListener('change', () => { setFeel({ clicks: feelClicks.checked }); drawFeel(); });
  drawFeel();

  const soundToggle = root.querySelector('#sound-toggle');
  const volumeEl = root.querySelector('#sound-volume');
  const soundNote = root.querySelector('#sound-note');
  function drawSound() {
    const { on, volume } = getSoundSettings();
    soundToggle.querySelectorAll('[data-sound]').forEach((b) => {
      const active = (b.dataset.sound === 'on') === on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    volumeEl.value = String(Math.round(volume * 100));
    volumeEl.disabled = !on;
    if (!soundSupported()) soundNote.textContent = "This browser can't play the sounds.";
    else if (prefersQuiet() && !on) soundNote.textContent = 'Your system asks for reduced motion, so sounds stay off unless you turn them on here.';
    else soundNote.textContent = '';
  }
  drawSound();
  soundToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sound]');
    if (!button) return;
    const on = button.dataset.sound === 'on';
    setSoundSettings({ on });
    drawSound();
    drawFeel(); // the "needs sound on" hint may change
    if (on) playSound('chime'); // a little confirmation that it works
  });
  volumeEl.addEventListener('change', () => {
    setSoundSettings({ volume: Number(volumeEl.value) / 100 });
    playSound('tick');
  });
  root.querySelector('#sound-test').addEventListener('click', () => {
    // force: lets you hear the sound even while sounds are off
    playSound('success', { force: true });
  });

  /* ---------------------------------------------------------------- reset */
  root.querySelector('#reset-btn').addEventListener('click', openResetDialog);
  mountAutoBackup(root.querySelector('#auto-backup')); // "Last automatic backup" + "Back up now"

  const fileInput = root.querySelector('#import-file');
  const statusEl = root.querySelector('#import-status');
  const versionEl = root.querySelector('#version');

  api.health()
    .then((h) => { if (versionEl.isConnected) versionEl.textContent = `AniShelf v${h.version || '?'} · server running`; })
    .catch(() => { if (versionEl.isConnected) versionEl.textContent = 'Server not reachable'; });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast('That file is too large to be an AniShelf backup.', 'error');
      return;
    }
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast("That file isn't valid JSON.", 'error');
      return;
    }
    const count = Array.isArray(data && data.entries) ? data.entries.length : null;
    const ok = await confirmDialog(
      count !== null
        ? `Import ${plural(count, 'anime')} from "${file.name}"? Matching anime in your library will be updated.`
        : `Import "${file.name}"? Matching anime in your library will be updated.`,
      { title: 'Restore backup?', okText: 'Import' },
    );
    if (!ok) return;
    statusEl.textContent = 'Importing…';
    try {
      const { imported = 0 } = await api.importBackup(data);
      statusEl.textContent = `Imported ${plural(imported, 'anime')}`;
      toast(`Imported ${plural(imported, 'anime')}`, 'success');
    } catch (err) {
      statusEl.textContent = '';
      toast(err.message, 'error');
    }
  });
}
