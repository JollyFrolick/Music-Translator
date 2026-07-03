import { pinyin } from "https://esm.sh/pinyin-pro@3.28.1";
import ToJyutping from "https://esm.sh/to-jyutping@3.1.1";

const STORAGE_KEY = "lyric-lens-draft";
const sampleLyrics = `月亮代表我的心
你问我爱你有多深
我爱你有几分

如果可以恨你
全力痛恨你
連遇上亦要躲避`;

const state = {
  language: "mandarin",
  searchMode: "song",
  searchQuery: "",
  title: "",
  artist: "",
  lyrics: sampleLyrics,
  translations: [],
  searchResults: [],
  searchMeta: null,
  message: ""
};

const root = document.querySelector("#root");
let isComposingText = false;

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

function renderOutputPanel() {
  const lines = getLines();
  const label = romanizationLabel();

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
                      <p class="${line.english ? "english" : "english muted"}">${escapeHtml(line.english || "Translation pending")}</p>
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
    statusIcon.textContent = state.message.includes("offline") ? "!" : "#";
  }
  if (statusText) {
    statusText.textContent = state.message || `${splitLyrics(state.lyrics).length} lines`;
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

function render() {
  const lines = getLines();
  const label = romanizationLabel();
  const isCustomMode = state.searchMode === "custom";

  root.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-mark" src="/icon.svg" alt="" />
          <div>
            <h1>Lyric Lens</h1>
            <p>${label} and English</p>
          </div>
        </div>

        <div class="status-strip" role="status">
          <span class="status-icon">${state.message.includes("offline") ? "!" : "#"}</span>
          <span class="status-text">${escapeHtml(state.message || `${lines.length} lines`)}</span>
        </div>
      </header>

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
          <button class="icon-button" type="button" data-action="sample" title="Load sample" aria-label="Load sample">↻</button>
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

          <button class="primary-action" type="button" data-action="translate">
            <span class="button-icon">*</span>
            <span>Translate</span>
          </button>
        </div>

        <div class="output-panel" aria-label="Translated lyrics">
          ${renderOutputPanel()}
        </div>
      </section>
    </main>
  `;
}

function setMessage(message) {
  state.message = message;
  render();
  saveDraft();
}

async function translate(button) {
  const lyricLines = splitLyrics(state.lyrics);
  if (!lyricLines.length) {
    setMessage("No lyrics yet.");
    return;
  }

  button.disabled = true;
  button.innerHTML = `<span class="button-icon spin">*</span><span>Translating</span>`;
  state.message = "";

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: state.language, lines: lyricLines })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Translation failed.");
    }

    state.translations = Array.isArray(data.translations) ? data.translations : [];
    setMessage("Translation ready.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Translation failed.");
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

  state.title = result.title || state.title;
  state.artist = result.artist || state.artist;
  state.searchQuery = state.searchMode === "artist" ? state.artist : state.title;
  state.lyrics = result.lyrics || "";
  state.translations = [];
  state.searchMeta = null;
  state.message = "Lyrics loaded.";
  saveDraft();
  render();
}

function searchSuggestedArtist(artist) {
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

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) {
    return;
  }

  state[field] = event.target.value;
  if (field === "lyrics") {
    state.translations = [];
    state.message = "";
    if (!event.isComposing && !isComposingText) {
      refreshOutputPanel();
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
    state.translations = [];
    state.message = "";
    refreshOutputPanel();
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

  if (action === "language") {
    state.language = button.dataset.language;
    state.translations = [];
    state.message = "";
    saveDraft();
    render();
  }

  if (action === "search-mode") {
    const nextMode = button.dataset.searchMode;
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
    state.lyrics = sampleLyrics;
    state.translations = [];
    state.searchResults = [];
    state.searchMeta = null;
    state.message = "";
    saveDraft();
    render();
  }

  if (action === "copy") {
    copyAll();
  }

  if (action === "download") {
    downloadText();
  }

  if (action === "clear") {
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
    useSearchResult(Number(button.dataset.index));
  }

  if (action === "artist-suggestion") {
    searchSuggestedArtist(button.dataset.artist || "");
  }

  if (action === "translate") {
    translate(button);
  }
}

loadDraft();
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
