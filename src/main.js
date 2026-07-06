import { pinyin } from "https://esm.sh/pinyin-pro@3.28.1";
import ToJyutping from "https://esm.sh/to-jyutping@3.1.1";

const STORAGE_KEY = "lyric-lens-draft";
const SAVED_TRANSLATIONS_KEY = "lyric-lens-saved-translations";
const maxSavedTranslations = 30;
const sampleLyrics = `月亮代表我的心
你问我爱你有多深
我爱你有几分

如果可以恨你
全力痛恨你
連遇上亦要躲避`;

const state = {
  screen: "menu",
  language: "mandarin",
  searchMode: "song",
  searchQuery: "",
  title: "",
  artist: "",
  lyrics: sampleLyrics,
  translations: [],
  savedTranslations: [],
  searchResults: [],
  searchMeta: null,
  message: ""
};

const root = document.querySelector("#root");
const autoTranslateDelayMs = 800;
let isComposingText = false;
let autoTranslateTimer = null;
let activeTranslationController = null;
let translationRequestId = 0;
let isTranslating = false;

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function splitLyrics(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function romanizeLine(line) {
  if (state.language === "cantonese") {
    return ToJyutping.getJyutpingText(line);
  }

  return pinyin(line, {
    toneType: "num",
    nonZh: "consecutive"
  });
}

function getLines() {
  return splitLyrics(state.lyrics).map((line, index) => ({
    original: line,
    romanization: romanizeLine(line),
    english: state.translations[index] || ""
  }));
}

function romanizationLabel() {
  return state.language === "cantonese" ? "Jyutping" : "Pinyin";
}

function languageName(language) {
  return language === "cantonese" ? "Cantonese" : "Mandarin";
}

function getTranslationSignature(lines = splitLyrics(state.lyrics)) {
  return JSON.stringify({
    language: state.language,
    lines
  });
}

function normalizeTranslationList(translations, lineCount) {
  return Array.from({ length: lineCount }, (_, index) =>
    typeof translations[index] === "string" ? translations[index].trim() : ""
  );
}

function hasCompleteTranslations(lines = splitLyrics(state.lyrics), translations = state.translations) {
  return (
    lines.length > 0 &&
    lines.every((_, index) => typeof translations[index] === "string" && translations[index].trim())
  );
}

function getStatusIcon() {
  if (isTranslating) {
    return "*";
  }
  return state.message.includes("offline") ? "!" : "#";
}

function getStatusText(lineCount = splitLyrics(state.lyrics).length) {
  if (isTranslating) {
    return "Translating to English...";
  }
  return state.message || `${lineCount} lines`;
}

function cancelAutoTranslate({ abort = false } = {}) {
  if (autoTranslateTimer) {
    clearTimeout(autoTranslateTimer);
    autoTranslateTimer = null;
  }

  if (abort && activeTranslationController) {
    activeTranslationController.abort();
    activeTranslationController = null;
    translationRequestId += 1;
    isTranslating = false;
  }
}

function scheduleAutoTranslate(delay = autoTranslateDelayMs) {
  cancelAutoTranslate();

  const lyricLines = splitLyrics(state.lyrics);
  if (!lyricLines.length || hasCompleteTranslations(lyricLines)) {
    return;
  }

  autoTranslateTimer = window.setTimeout(() => {
    autoTranslateTimer = null;
    translateLyrics();
  }, delay);
}

function saveDraft() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      language: state.language,
      searchMode: state.searchMode,
      searchQuery: state.searchQuery,
      title: state.title,
      artist: state.artist,
      lyrics: state.lyrics,
      translations: state.translations,
      message: state.message
    })
  );
}

function loadDraft() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return;
  }

  try {
    const draft = JSON.parse(saved);
    state.language = draft.language === "cantonese" ? "cantonese" : "mandarin";
    state.searchMode = ["artist", "custom"].includes(draft.searchMode) ? draft.searchMode : "song";
    state.searchQuery = draft.searchQuery || "";
    state.title = draft.title || "";
    state.artist = draft.artist || "";
    state.lyrics = draft.lyrics || sampleLyrics;
    state.translations = Array.isArray(draft.translations) ? draft.translations : [];
    state.searchResults = [];
    state.searchMeta = null;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function normalizeSavedTranslation(item) {
  if (!item || typeof item !== "object" || typeof item.lyrics !== "string") {
    return null;
  }

  const lines = splitLyrics(item.lyrics);
  if (!lines.length) {
    return null;
  }

  const language = item.language === "cantonese" ? "cantonese" : "mandarin";

  return {
    id: typeof item.id === "string" && item.id ? item.id : createId(),
    savedAt: typeof item.savedAt === "string" && item.savedAt ? item.savedAt : new Date().toISOString(),
    language,
    searchMode: ["artist", "custom"].includes(item.searchMode) ? item.searchMode : "song",
    searchQuery: typeof item.searchQuery === "string" ? item.searchQuery : "",
    title: typeof item.title === "string" ? item.title : "",
    artist: typeof item.artist === "string" ? item.artist : "",
    lyrics: item.lyrics.trim(),
    translations: normalizeTranslationList(Array.isArray(item.translations) ? item.translations : [], lines.length)
  };
}

function loadSavedTranslations() {
  const saved = localStorage.getItem(SAVED_TRANSLATIONS_KEY);
  if (!saved) {
    return;
  }

  try {
    const items = JSON.parse(saved);
    state.savedTranslations = Array.isArray(items)
      ? items.map(normalizeSavedTranslation).filter(Boolean).slice(0, maxSavedTranslations)
      : [];
  } catch {
    localStorage.removeItem(SAVED_TRANSLATIONS_KEY);
    state.savedTranslations = [];
  }
}

function saveSavedTranslations() {
  localStorage.setItem(SAVED_TRANSLATIONS_KEY, JSON.stringify(state.savedTranslations));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildExport(lines) {
  const heading = [
    state.title ? `Title: ${state.title}` : "",
    state.artist ? `Artist: ${state.artist}` : "",
    `Romanization: ${romanizationLabel()}`
  ]
    .filter(Boolean)
    .join("\n");

  const body = lines
    .map((line, index) =>
      [
        `${index + 1}. ${line.original}`,
        line.romanization,
        line.english || "[translation pending]"
      ].join("\n")
    )
    .join("\n\n");

  return `${heading}\n\n${body}\n`;
}

function formatDuration(duration) {
  if (!duration) {
    return "";
  }

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderSearchResults() {
  const similarArtists = state.searchMeta?.similarArtists || [];

  if (!state.searchResults.length && !similarArtists.length) {
    return "";
  }

  const modeLabel = state.searchMode === "artist" ? "artist" : "song";
  const notice = state.searchMeta?.showingSimilar
    ? `<div class="search-notice">
        <strong>No exact ${modeLabel} found.</strong>
        <span>Showing similar ${modeLabel === "artist" ? "artists and songs" : "songs"} instead.</span>
      </div>`
    : "";

  const artistSuggestions = similarArtists.length
    ? `<div class="similar-artists" aria-label="Similar artists">
        ${similarArtists
          .map(
            (artist) => `
              <button type="button" data-action="artist-suggestion" data-artist="${escapeHtml(artist)}">
                ${escapeHtml(artist)}
              </button>
            `
          )
          .join("")}
      </div>`
    : "";

  return `
    <div class="search-results" aria-label="Song matches">
      ${notice}
      ${artistSuggestions}
      ${state.searchResults
        .map(
          (result, index) => `
            <button class="song-result" type="button" data-action="use-result" data-index="${index}">
              <span class="song-main">
                <strong>${escapeHtml(result.title)}</strong>
                <span>${escapeHtml(result.artist)}</span>
              </span>
              <span class="${result.isExact ? "match-pill exact" : "match-pill similar"}">
                ${result.isExact ? "Exact" : "Similar"}
              </span>
              <span class="song-meta">
                ${escapeHtml([result.album, formatDuration(result.duration)].filter(Boolean).join(" · "))}
              </span>
              <span class="song-preview">${escapeHtml(result.preview || "Lyrics available")}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderLoadedTrack() {
  if (state.searchMode === "custom" || (!state.title && !state.artist)) {
    return "";
  }

  return `
    <div class="loaded-track">
      <span>Loaded</span>
      <strong>${escapeHtml(state.title || "Untitled song")}</strong>
      <em>${escapeHtml(state.artist || "Unknown artist")}</em>
    </div>
  `;
}

function savedSongTitle(item) {
  return item.title || splitLyrics(item.lyrics)[0] || "Untitled song";
}

function savedSongArtist(item) {
  return item.artist || "Unknown artist";
}

function renderSavedSongs() {
  const count = state.savedTranslations.length;

  return `
    <section class="saved-section menu-saved-section" aria-label="Saved songs">
      <div class="saved-heading">
        <div>
          <h2>Saved Songs</h2>
          <p>${count ? `${count} saved` : "No saved songs"}</p>
        </div>
      </div>

      ${
        count
          ? `<div class="saved-list">
              ${state.savedTranslations
                .map((item, index) => {
                  const title = savedSongTitle(item);
                  const artist = savedSongArtist(item);

                  return `
                    <article class="saved-card">
                      <button class="saved-open" type="button" data-action="open-saved" data-index="${index}">
                        <span class="saved-main">
                          <strong>${escapeHtml(title)}</strong>
                          <span>${escapeHtml(artist)}</span>
                        </span>
                        <span class="saved-language">${escapeHtml(languageName(item.language))}</span>
                      </button>
                      <button class="saved-delete" type="button" data-action="delete-saved" data-index="${index}" title="Remove saved song" aria-label="Remove saved song">×</button>
                    </article>
                  `;
                })
                .join("")}
            </div>`
          : `<div class="saved-empty">Saved songs will appear here.</div>`
      }
    </section>
  `;
}

function renderOutputPanel() {
  const lines = getLines();
  const label = romanizationLabel();
  const translationPlaceholder = isTranslating ? "Translating..." : "Translation pending";

  return `
    <div class="output-heading">
      <div>
        <h2>Lines</h2>
        <p>${label}</p>
      </div>
      <span class="heading-icon">Aa</span>
    </div>

    ${
      lines.length
        ? `<div class="line-list">
            ${lines
              .map(
                (line, index) => `
                  <article class="lyric-card">
                    <div class="line-number">${String(index + 1).padStart(2, "0")}</div>
                    <div class="line-content">
                      <p class="original">${escapeHtml(line.original)}</p>
                      <p class="romanization">${escapeHtml(line.romanization)}</p>
                      <p class="${line.english ? "english" : "english muted"}">${escapeHtml(line.english || translationPlaceholder)}</p>
                    </div>
                  </article>
                `
              )
              .join("")}
          </div>`
        : `<div class="empty-state"><span class="empty-icon">#</span><p>No lyrics yet.</p></div>`
    }
  `;
}

function refreshStatus() {
  const statusIcon = root.querySelector(".status-icon");
  const statusText = root.querySelector(".status-text");

  if (statusIcon) {
    statusIcon.textContent = getStatusIcon();
  }
  if (statusText) {
    statusText.textContent = getStatusText();
  }
}

function refreshOutputPanel() {
  const outputPanel = root.querySelector(".output-panel");
  if (outputPanel) {
    outputPanel.innerHTML = renderOutputPanel();
  }
  refreshStatus();
}

function clearSearchResultsView() {
  const searchResults = root.querySelector(".search-results");
  if (searchResults) {
    searchResults.remove();
  }
}

function renderTopbar({ subtitle = `${romanizationLabel()} and English`, statusText = getStatusText(), statusIcon = getStatusIcon() } = {}) {
  return `
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/icon.svg" alt="" />
        <div>
          <h1>Lyric Lens</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>

      <div class="status-strip" role="status">
        <span class="status-icon">${escapeHtml(statusIcon)}</span>
        <span class="status-text">${escapeHtml(statusText)}</span>
      </div>
    </header>
  `;
}

function renderMenu() {
  const savedCount = state.savedTranslations.length;

  root.innerHTML = `
    <main class="app-shell menu-shell">
      ${renderTopbar({
        subtitle: "Saved songs",
        statusText: savedCount ? `${savedCount} saved` : "No saved songs",
        statusIcon: "#"
      })}

      <section class="menu-actions" aria-label="Search options">
        <button class="menu-search-button" type="button" data-action="start-search" data-search-mode="artist">
          <span>Search by Artist</span>
        </button>
        <button class="menu-search-button" type="button" data-action="start-search" data-search-mode="song">
          <span>Search by Song Name</span>
        </button>
      </section>

      ${renderSavedSongs()}
    </main>
  `;
}

function renderSavedDetail() {
  const title = state.title || splitLyrics(state.lyrics)[0] || "Saved song";
  const detailSubtitle = [title, state.artist, languageName(state.language)].filter(Boolean).join(" · ");

  root.innerHTML = `
    <main class="app-shell detail-shell">
      ${renderTopbar({
        subtitle: detailSubtitle,
        statusText: getStatusText(splitLyrics(state.lyrics).length)
      })}

      <section class="toolbar" aria-label="Saved song controls">
        <button class="secondary-action home-action" type="button" data-action="menu">
          <span class="button-icon">←</span>
          <span>Saved Songs</span>
        </button>

        <div class="actions compact-actions">
          <button class="icon-button" type="button" data-action="copy" title="Copy result" aria-label="Copy result">⧉</button>
          <button class="icon-button" type="button" data-action="download" title="Download result" aria-label="Download result">↓</button>
        </div>
      </section>

      <section class="detail-workspace">
        <div class="output-panel" aria-label="Translated lyrics">
          ${renderOutputPanel()}
        </div>
      </section>
    </main>
  `;
}

function renderSearchScreen() {
  const lines = getLines();
  const label = romanizationLabel();
  const isCustomMode = state.searchMode === "custom";
  const statusText = getStatusText(lines.length);

  root.innerHTML = `
    <main class="app-shell">
      ${renderTopbar({ subtitle: `${label} and English`, statusText })}

      <section class="toolbar" aria-label="Lyric controls">
        <div class="segmented" aria-label="Language">
          <button class="${state.language === "mandarin" ? "active" : ""}" type="button" data-action="language" data-language="mandarin">
            Mandarin
          </button>
          <button class="${state.language === "cantonese" ? "active" : ""}" type="button" data-action="language" data-language="cantonese">
            Cantonese
          </button>
        </div>

        <div class="actions">
          <button class="icon-button" type="button" data-action="menu" title="Main menu" aria-label="Main menu">←</button>
          <button class="icon-button" type="button" data-action="sample" title="Load sample" aria-label="Load sample">↻</button>
          <button class="icon-button" type="button" data-action="save" title="Save translation" aria-label="Save translation">☆</button>
          <button class="icon-button" type="button" data-action="copy" title="Copy result" aria-label="Copy result">⧉</button>
          <button class="icon-button" type="button" data-action="download" title="Download result" aria-label="Download result">↓</button>
          <button class="icon-button danger" type="button" data-action="clear" title="Clear lyrics" aria-label="Clear lyrics">×</button>
        </div>
      </section>

      <section class="workspace">
        <div class="input-panel">
          <div class="search-panel">
            <div class="segmented search-mode" aria-label="Search type">
              <button class="${state.searchMode === "song" ? "active" : ""}" type="button" data-action="search-mode" data-search-mode="song">
                Song
              </button>
              <button class="${state.searchMode === "artist" ? "active" : ""}" type="button" data-action="search-mode" data-search-mode="artist">
                Artist
              </button>
              <button class="${state.searchMode === "custom" ? "active" : ""}" type="button" data-action="search-mode" data-search-mode="custom">
                Custom
              </button>
            </div>

            ${
              isCustomMode
                ? `<label class="custom-lyrics-box">
                    <span>Custom lyrics</span>
                    <textarea
                      data-field="lyrics"
                      spellcheck="false"
                      autocapitalize="off"
                      placeholder="Paste your lyrics here"
                    >${escapeHtml(state.lyrics)}</textarea>
                  </label>`
                : `<label>
                    <span>${state.searchMode === "artist" ? "Artist name" : "Song title"}</span>
                    <input
                      value="${escapeHtml(state.searchQuery)}"
                      data-field="searchQuery"
                      autocomplete="off"
                      autocapitalize="off"
                      placeholder="${state.searchMode === "artist" ? "邓丽君" : "月亮代表我的心"}"
                    />
                  </label>`
            }

            ${
              isCustomMode
                ? ""
                : `<button class="secondary-action" type="button" data-action="search">
                    <span class="button-icon">?</span>
                    <span>Find lyrics</span>
                  </button>`
            }

            ${renderLoadedTrack()}
          </div>

          ${isCustomMode ? "" : renderSearchResults()}

          ${
            isCustomMode
              ? ""
              : `<label class="lyrics-box">
                  <span>Lyrics</span>
                  <textarea data-field="lyrics" spellcheck="false" autocapitalize="off">${escapeHtml(state.lyrics)}</textarea>
                </label>`
          }
        </div>

        <div class="output-panel" aria-label="Translated lyrics">
          ${renderOutputPanel()}
        </div>
      </section>
    </main>
  `;
}

function render() {
  if (state.screen === "menu") {
    renderMenu();
    return;
  }

  if (state.screen === "detail") {
    renderSavedDetail();
    return;
  }

  renderSearchScreen();
}

function setMessage(message) {
  state.message = message;
  render();
  saveDraft();
}

async function translateLyrics() {
  const lyricLines = splitLyrics(state.lyrics);
  if (!lyricLines.length) {
    state.translations = [];
    isTranslating = false;
    setMessage("No lyrics yet.");
    return;
  }

  if (hasCompleteTranslations(lyricLines)) {
    return;
  }

  const requestId = ++translationRequestId;
  const signature = getTranslationSignature(lyricLines);

  if (activeTranslationController) {
    activeTranslationController.abort();
  }

  const controller = new AbortController();
  activeTranslationController = controller;
  isTranslating = true;
  state.message = "Translating to English...";
  refreshOutputPanel();
  saveDraft();

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: state.language, lines: lyricLines }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Translation failed.");
    }

    const translations = normalizeTranslationList(
      Array.isArray(data.translations) ? data.translations : [],
      lyricLines.length
    );

    if (!hasCompleteTranslations(lyricLines, translations)) {
      throw new Error("Translation returned incomplete results.");
    }

    if (requestId !== translationRequestId || signature !== getTranslationSignature()) {
      return;
    }

    state.translations = translations;
    isTranslating = false;
    state.message = "Translation ready.";
    refreshOutputPanel();
    saveDraft();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    if (requestId !== translationRequestId || signature !== getTranslationSignature()) {
      return;
    }

    isTranslating = false;
    state.message = error instanceof Error ? error.message : "Translation failed.";
    refreshOutputPanel();
    saveDraft();
  } finally {
    if (activeTranslationController === controller) {
      activeTranslationController = null;
    }
  }
}

async function searchLyrics(button) {
  if (state.searchMode === "custom") {
    setMessage("Paste custom lyrics below.");
    return;
  }

  const query = state.searchQuery.trim();

  if (!query) {
    setMessage(state.searchMode === "artist" ? "Enter an artist name." : "Enter a song title.");
    return;
  }

  button.disabled = true;
  button.innerHTML = `<span class="button-icon spin">?</span><span>Searching</span>`;
  state.message = "";

  try {
    const params = new URLSearchParams();
    if (state.searchMode === "artist") {
      params.set("artist", query);
    } else {
      params.set("title", query);
    }

    const response = await fetch(`/api/lyrics-search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Lyrics search failed.");
    }

    state.searchResults = Array.isArray(data.results) ? data.results : [];
    state.searchMeta = data.meta || null;
    if (!state.searchResults.length) {
      setMessage("No matches found.");
    } else if (state.searchMeta?.showingSimilar) {
      setMessage(
        state.searchMode === "artist"
          ? "No exact artist found. Showing similar artists."
          : "No exact song found. Showing similar songs."
      );
    } else {
      setMessage(`${state.searchResults.length} matches found.`);
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Lyrics search failed.");
  }
}

function useSearchResult(index) {
  const result = state.searchResults[index];
  if (!result) {
    return;
  }

  cancelAutoTranslate({ abort: true });
  state.title = result.title || state.title;
  state.artist = result.artist || state.artist;
  state.searchQuery = state.searchMode === "artist" ? state.artist : state.title;
  state.lyrics = result.lyrics || "";
  state.translations = [];
  state.searchMeta = null;
  state.message = "Lyrics loaded.";
  saveDraft();
  render();
  scheduleAutoTranslate(0);
}

function searchSuggestedArtist(artist) {
  state.screen = "search";
  state.searchMode = "artist";
  state.searchQuery = artist;
  state.searchResults = [];
  state.searchMeta = null;
  state.message = "";
  saveDraft();
  render();

  const searchButton = root.querySelector('[data-action="search"]');
  if (searchButton) {
    searchLyrics(searchButton);
  }
}

async function copyAll() {
  const lines = getLines();
  if (!lines.length) {
    setMessage("No lyrics yet.");
    return;
  }

  await navigator.clipboard.writeText(buildExport(lines));
  setMessage("Copied.");
}

function downloadText() {
  const lines = getLines();
  if (!lines.length) {
    setMessage("No lyrics yet.");
    return;
  }

  const blob = new Blob([buildExport(lines)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.title || "translated-lyrics"}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
  setMessage("Downloaded.");
}

function getSavedTranslationKey(item) {
  return JSON.stringify({
    language: item.language,
    lines: splitLyrics(item.lyrics)
  });
}

function saveCurrentTranslation() {
  const lyricLines = splitLyrics(state.lyrics);
  if (!lyricLines.length) {
    setMessage("No lyrics yet.");
    return;
  }

  if (!hasCompleteTranslations(lyricLines)) {
    if (!isTranslating) {
      scheduleAutoTranslate(0);
    }
    setMessage(isTranslating ? "Wait for translation to finish." : "Translation needed before saving.");
    return;
  }

  const savedItem = {
    id: createId(),
    savedAt: new Date().toISOString(),
    language: state.language,
    searchMode: state.searchMode,
    searchQuery: state.searchQuery,
    title: state.title.trim(),
    artist: state.artist.trim(),
    lyrics: state.lyrics.trim(),
    translations: normalizeTranslationList(state.translations, lyricLines.length)
  };
  const savedKey = getSavedTranslationKey(savedItem);
  const existingIndex = state.savedTranslations.findIndex((item) => getSavedTranslationKey(item) === savedKey);

  if (existingIndex >= 0) {
    state.savedTranslations.splice(existingIndex, 1);
  }

  state.savedTranslations.unshift(savedItem);
  state.savedTranslations = state.savedTranslations.slice(0, maxSavedTranslations);
  saveSavedTranslations();
  setMessage("Saved translation.");
}

function showMenu() {
  cancelAutoTranslate({ abort: true });
  state.screen = "menu";
  state.message = "";
  render();
}

function startSearch(mode) {
  cancelAutoTranslate({ abort: true });
  state.screen = "search";
  state.searchMode = mode === "artist" ? "artist" : "song";
  state.searchQuery = "";
  state.title = "";
  state.artist = "";
  state.lyrics = "";
  state.translations = [];
  state.searchResults = [];
  state.searchMeta = null;
  state.message = "";
  saveDraft();
  render();
}

function openSavedTranslation(index) {
  const savedItem = state.savedTranslations[index];
  if (!savedItem) {
    return;
  }

  const lyricLines = splitLyrics(savedItem.lyrics);
  cancelAutoTranslate({ abort: true });
  state.screen = "detail";
  state.language = savedItem.language;
  state.searchMode = savedItem.searchMode;
  state.searchQuery = savedItem.searchQuery || savedItem.title || "";
  state.title = savedItem.title;
  state.artist = savedItem.artist;
  state.lyrics = savedItem.lyrics;
  state.translations = normalizeTranslationList(savedItem.translations, lyricLines.length);
  state.searchResults = [];
  state.searchMeta = null;
  state.message = "Saved translation loaded.";
  saveDraft();
  render();
}

function deleteSavedTranslation(index) {
  if (!state.savedTranslations[index]) {
    return;
  }

  state.savedTranslations.splice(index, 1);
  saveSavedTranslations();
  setMessage("Removed saved translation.");
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) {
    return;
  }

  state[field] = event.target.value;
  if (field === "lyrics") {
    cancelAutoTranslate({ abort: true });
    state.translations = [];
    state.message = "";
    if (!event.isComposing && !isComposingText) {
      refreshOutputPanel();
      scheduleAutoTranslate();
    }
  }
  if (field === "searchQuery") {
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    clearSearchResultsView();
    refreshStatus();
  }
  saveDraft();
}

function handleCompositionStart(event) {
  if (event.target.dataset.field) {
    isComposingText = true;
  }
}

function handleCompositionEnd(event) {
  const field = event.target.dataset.field;
  if (!field) {
    return;
  }

  isComposingText = false;
  state[field] = event.target.value;

  if (field === "lyrics") {
    cancelAutoTranslate({ abort: true });
    state.translations = [];
    state.message = "";
    refreshOutputPanel();
    scheduleAutoTranslate(250);
  }

  if (field === "searchQuery") {
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    clearSearchResultsView();
    refreshStatus();
  }

  saveDraft();
}

function handleClick(event) {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (action === "menu") {
    showMenu();
  }

  if (action === "start-search") {
    startSearch(button.dataset.searchMode);
  }

  if (action === "language") {
    if (state.language === button.dataset.language) {
      return;
    }
    cancelAutoTranslate({ abort: true });
    state.language = button.dataset.language;
    state.translations = [];
    state.message = "";
    saveDraft();
    render();
    scheduleAutoTranslate(0);
  }

  if (action === "search-mode") {
    const nextMode = button.dataset.searchMode;
    state.screen = "search";
    state.searchMode = ["artist", "custom"].includes(nextMode) ? nextMode : "song";
    if (state.searchMode !== "custom") {
      state.searchQuery = "";
    }
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    saveDraft();
    render();
  }

  if (action === "sample") {
    cancelAutoTranslate({ abort: true });
    state.screen = "search";
    state.lyrics = sampleLyrics;
    state.translations = [];
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    saveDraft();
    render();
    scheduleAutoTranslate(0);
  }

  if (action === "copy") {
    copyAll();
  }

  if (action === "download") {
    downloadText();
  }

  if (action === "save") {
    saveCurrentTranslation();
  }

  if (action === "clear") {
    cancelAutoTranslate({ abort: true });
    state.searchQuery = "";
    state.title = "";
    state.artist = "";
    state.lyrics = "";
    state.translations = [];
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    saveDraft();
    render();
  }

  if (action === "search") {
    searchLyrics(button);
  }

  if (action === "use-result") {
    state.screen = "search";
    useSearchResult(Number(button.dataset.index));
  }

  if (action === "artist-suggestion") {
    searchSuggestedArtist(button.dataset.artist || "");
  }

  if (action === "open-saved") {
    openSavedTranslation(Number(button.dataset.index));
  }

  if (action === "delete-saved") {
    deleteSavedTranslation(Number(button.dataset.index));
  }
}

loadDraft();
loadSavedTranslations();
render();
root.addEventListener("input", handleInput);
root.addEventListener("compositionstart", handleCompositionStart);
root.addEventListener("compositionend", handleCompositionEnd);
root.addEventListener("click", handleClick);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
