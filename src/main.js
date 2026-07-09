import { pinyin } from "https://esm.sh/pinyin-pro@3.28.1";
import ToJyutping from "https://esm.sh/to-jyutping@3.1.1";

const STORAGE_KEY = "lyric-lens-draft";
const SAVED_TRANSLATIONS_KEY = "lyric-lens-saved-translations";
const CLOUD_TABLE = "saved_translations";
const PROFILE_TABLE = "profiles";
const SUPABASE_MODULE_URL = "https://esm.sh/@supabase/supabase-js@2";
const FREE_SAVE_LIMIT = 5;
const sampleLyrics = `月亮代表我的心
你问我爱你有多深
我爱你有几分

如果可以恨你
全力痛恨你
連遇上亦要躲避`;

const state = {
  screen: "menu",
  accountReturnScreen: "menu",
  language: "mandarin",
  searchMode: "song",
  searchQuery: "",
  title: "",
  artist: "",
  lyrics: sampleLyrics,
  translations: [],
  savedTranslations: [],
  currentSavedTranslationId: "",
  isEditingSavedTranslation: false,
  pendingDeleteSavedTranslationId: "",
  searchResults: [],
  searchMeta: null,
  message: "",
  paymentReturnScreen: "menu",
  paymentMessage: "",
  config: {
    premiumCheckoutUrl: ""
  },
  auth: {
    status: "disabled",
    user: null,
    email: "",
    password: "",
    plan: "free",
    message: "",
    busy: false
  }
};

const root = document.querySelector("#root");
const autoTranslateDelayMs = 800;
let isComposingText = false;
let autoTranslateTimer = null;
let activeTranslationController = null;
let translationRequestId = 0;
let isTranslating = false;
const containedScrollSelector = ".lyrics-box textarea, .custom-lyrics-box textarea, .line-list";
const touchStartByElement = new WeakMap();
let supabaseClient = null;
let authChangeSubscription = null;

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
      ? dedupeSavedTranslations(items, { applyLimit: false })
      : [];
  } catch {
    localStorage.removeItem(SAVED_TRANSLATIONS_KEY);
    state.savedTranslations = [];
  }
}

function saveSavedTranslations() {
  localStorage.setItem(SAVED_TRANSLATIONS_KEY, JSON.stringify(state.savedTranslations));
}

function isCloudSyncReady() {
  return Boolean(supabaseClient && state.auth.status === "signed-in" && state.auth.user?.id);
}

function isPremiumPlan() {
  return state.auth.plan === "premium";
}

function getSavedTranslationLimit() {
  return isPremiumPlan() ? null : FREE_SAVE_LIMIT;
}

function limitSavedTranslations(items) {
  const limit = getSavedTranslationLimit();
  return typeof limit === "number" ? items.slice(0, limit) : items;
}

function dedupeSavedTranslations(items, { applyLimit = true } = {}) {
  const seen = new Set();
  const deduped = items
    .map(normalizeSavedTranslation)
    .filter(Boolean)
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
    .filter((item) => {
      const key = getSavedTranslationKey(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return applyLimit ? limitSavedTranslations(deduped) : deduped;
}

function enforceSavedTranslationLimit() {
  const limitedItems = dedupeSavedTranslations(state.savedTranslations);
  const changed =
    limitedItems.length !== state.savedTranslations.length ||
    limitedItems.some((item, index) => item.id !== state.savedTranslations[index]?.id);

  state.savedTranslations = limitedItems;

  if (changed) {
    saveSavedTranslations();
  }

  return changed;
}

function canAddSavedTranslation() {
  const limit = getSavedTranslationLimit();
  return typeof limit !== "number" || state.savedTranslations.length < limit;
}

function getSavedUsageText(count = state.savedTranslations.length) {
  const limit = getSavedTranslationLimit();
  if (typeof limit === "number") {
    return `${count}/${limit} saved`;
  }
  return count ? `${count} saved` : "No saved songs";
}

function getPlanLabel() {
  return isPremiumPlan() ? "Premium" : "Free";
}

function getPremiumStatusText() {
  return isPremiumPlan() ? "Premium active" : "Get Premium";
}

function getSaveLimitMessage() {
  if (state.auth.status === "signed-out") {
    return `Free plan allows ${FREE_SAVE_LIMIT} saves. Sign in with a premium account for unlimited saves.`;
  }

  return `Free plan allows ${FREE_SAVE_LIMIT} saves. Premium removes the save limit.`;
}

function savedItemToCloudRow(item) {
  return {
    id: item.id,
    user_id: state.auth.user.id,
    saved_at: item.savedAt,
    language: item.language,
    search_mode: item.searchMode,
    search_query: item.searchQuery,
    title: item.title,
    artist: item.artist,
    lyrics: item.lyrics,
    translations: item.translations
  };
}

function cloudRowToSavedItem(row) {
  return normalizeSavedTranslation({
    id: row.id,
    savedAt: row.saved_at,
    language: row.language,
    searchMode: row.search_mode,
    searchQuery: row.search_query,
    title: row.title,
    artist: row.artist,
    lyrics: row.lyrics,
    translations: Array.isArray(row.translations) ? row.translations : []
  });
}

async function syncSavedTranslation(savedItem, { silent = false } = {}) {
  if (!isCloudSyncReady()) {
    return false;
  }

  const { error } = await supabaseClient
    .from(CLOUD_TABLE)
    .upsert(savedItemToCloudRow(savedItem), { onConflict: "id" });

  if (error) {
    if (!silent) {
      setMessage("Saved on this device. Cloud sync failed.");
    }
    console.error(error);
    return false;
  }

  return true;
}

async function loadAccountPlan(user) {
  state.auth.plan = "free";

  if (!supabaseClient || !user?.id) {
    return;
  }

  const { data, error } = await supabaseClient
    .from(PROFILE_TABLE)
    .select("plan")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error(error);
    return;
  }

  state.auth.plan = data?.plan === "premium" ? "premium" : "free";
}

async function deleteCloudSavedTranslation(savedItem) {
  if (!isCloudSyncReady() || !savedItem?.id) {
    return;
  }

  const { error } = await supabaseClient.from(CLOUD_TABLE).delete().eq("id", savedItem.id);
  if (error) {
    console.error(error);
    setMessage("Removed here. Cloud delete failed.");
  }
}

async function loadCloudSavedTranslations({ mergeLocal = false } = {}) {
  if (!isCloudSyncReady()) {
    return;
  }

  const localItems = mergeLocal ? state.savedTranslations : [];
  const { data, error } = await supabaseClient
    .from(CLOUD_TABLE)
    .select("id,saved_at,language,search_mode,search_query,title,artist,lyrics,translations")
    .order("saved_at", { ascending: false });

  if (error) {
    console.error(error);
    state.auth.message = "Could not load cloud library.";
    render();
    return;
  }

  const cloudItems = Array.isArray(data) ? data.map(cloudRowToSavedItem).filter(Boolean) : [];
  const cloudKeys = new Set(cloudItems.map(getSavedTranslationKey));
  const unsyncedLocalItems = localItems.filter((item) => !cloudKeys.has(getSavedTranslationKey(item)));
  const nextItems = dedupeSavedTranslations([...unsyncedLocalItems, ...cloudItems]);
  const nextKeys = new Set(nextItems.map(getSavedTranslationKey));

  for (const item of unsyncedLocalItems.filter((item) => nextKeys.has(getSavedTranslationKey(item)))) {
    await syncSavedTranslation(item, { silent: true });
  }

  state.savedTranslations = nextItems;
  saveSavedTranslations();
  render();
}

async function applyAuthSession(session, { mergeLocal = false } = {}) {
  if (session?.user) {
    state.auth.status = "signed-in";
    state.auth.user = session.user;
    state.auth.email = session.user.email || state.auth.email;
    state.auth.password = "";
    state.auth.message = "Cloud sync on.";
    await loadAccountPlan(session.user);
    await loadCloudSavedTranslations({ mergeLocal });
    return;
  }

  state.auth.status = supabaseClient ? "signed-out" : "disabled";
  state.auth.user = null;
  state.auth.password = "";
  state.auth.plan = "free";
  state.auth.message = "";
  enforceSavedTranslationLimit();
  render();
}

async function initializeCloudSync() {
  state.auth.status = "loading";
  render();

  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const config = await response.json();
    state.config.premiumCheckoutUrl =
      typeof config.premiumCheckoutUrl === "string" ? config.premiumCheckoutUrl.trim() : "";

    if (!response.ok || !config.cloudSyncEnabled) {
      state.auth.status = "disabled";
      state.auth.plan = "free";
      state.auth.message = "Cloud sync not configured.";
      enforceSavedTranslationLimit();
      render();
      return;
    }

    const { createClient } = await import(SUPABASE_MODULE_URL);
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey);

    const sessionResult = await supabaseClient.auth.getSession();
    const session = sessionResult.data?.session || null;

    authChangeSubscription?.unsubscribe?.();
    const authListener = supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
      applyAuthSession(nextSession, { mergeLocal: true }).catch((error) => {
        console.error(error);
        state.auth.message = "Cloud sync failed.";
        render();
      });
    });
    authChangeSubscription = authListener.data?.subscription || null;

    await applyAuthSession(session, { mergeLocal: true });
  } catch (error) {
    console.error(error);
    state.auth.status = "disabled";
    state.auth.plan = "free";
    state.auth.message = "Cloud sync unavailable.";
    enforceSavedTranslationLimit();
    render();
  }
}

async function signInToCloud() {
  if (!supabaseClient || state.auth.busy) {
    return;
  }

  const email = state.auth.email.trim();
  const password = state.auth.password;
  if (!email || !password) {
    state.auth.message = "Enter email and password.";
    render();
    return;
  }

  state.auth.busy = true;
  state.auth.message = "Signing in...";
  render();

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  state.auth.busy = false;

  if (error) {
    state.auth.message = error.message || "Sign in failed.";
    render();
  }
}

async function createCloudAccount() {
  if (!supabaseClient || state.auth.busy) {
    return;
  }

  const email = state.auth.email.trim();
  const password = state.auth.password;
  if (!email || password.length < 6) {
    state.auth.message = "Use an email and a 6+ character password.";
    render();
    return;
  }

  state.auth.busy = true;
  state.auth.message = "Creating account...";
  render();

  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  state.auth.busy = false;

  if (error) {
    state.auth.message = error.message || "Account creation failed.";
    render();
    return;
  }

  if (!data.session) {
    state.auth.message = "Check your email, then sign in.";
    state.auth.password = "";
    render();
  }
}

async function signOutFromCloud() {
  if (!supabaseClient || state.auth.busy) {
    return;
  }

  state.auth.busy = true;
  state.auth.message = "Signing out...";
  render();

  const { error } = await supabaseClient.auth.signOut();
  state.auth.busy = false;

  if (error) {
    state.auth.message = error.message || "Sign out failed.";
    render();
    return;
  }

  showMenu();
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

function renderAuthPanel() {
  if (state.auth.status === "loading") {
    return `
      <section class="auth-panel" aria-label="Account">
        <div class="auth-heading">
          <div>
            <h2>Account</h2>
            <p>Checking sync...</p>
          </div>
          <span class="saved-language">Sync</span>
        </div>
      </section>
    `;
  }

  if (state.auth.status === "disabled") {
    return `
      <section class="auth-panel" aria-label="Account">
        <div class="auth-heading">
          <div>
            <h2>Account</h2>
            <p>${escapeHtml(state.auth.message || "Local saves only.")}</p>
          </div>
          <span class="saved-language">${getPlanLabel()}</span>
        </div>
      </section>
    `;
  }

  if (state.auth.status === "signed-in") {
    return `
      <section class="auth-panel" aria-label="Account">
        <div class="auth-heading">
          <div>
            <h2>Account</h2>
            <p>${escapeHtml(state.auth.email || "Signed in")}</p>
          </div>
          <span class="saved-language">${getPlanLabel()}</span>
        </div>
        <button class="secondary-action" type="button" data-action="auth-sign-out" ${state.auth.busy ? "disabled" : ""}>
          <span>${state.auth.busy ? "Signing out" : "Sign out"}</span>
        </button>
        ${state.auth.message ? `<p class="auth-message">${escapeHtml(state.auth.message)}</p>` : ""}
      </section>
    `;
  }

  return `
    <section class="auth-panel" aria-label="Account">
      <div class="auth-heading">
        <div>
          <h2>Account</h2>
          <p>Sync saved songs across devices.</p>
        </div>
        <span class="saved-language">${getPlanLabel()}</span>
      </div>
      <div class="auth-fields">
        <label>
          <span>Email</span>
          <input
            value="${escapeHtml(state.auth.email)}"
            data-auth-field="email"
            type="email"
            autocomplete="email"
            autocapitalize="off"
          />
        </label>
        <label>
          <span>Password</span>
          <input
            value="${escapeHtml(state.auth.password)}"
            data-auth-field="password"
            type="password"
            autocomplete="current-password"
          />
        </label>
      </div>
      <div class="auth-actions">
        <button class="secondary-action" type="button" data-action="auth-sign-in" ${state.auth.busy ? "disabled" : ""}>
          <span>${state.auth.busy ? "Signing in" : "Sign in"}</span>
        </button>
        <button class="secondary-action ghost-action" type="button" data-action="auth-sign-up" ${state.auth.busy ? "disabled" : ""}>
          <span>Create account</span>
        </button>
      </div>
      ${state.auth.message ? `<p class="auth-message">${escapeHtml(state.auth.message)}</p>` : ""}
    </section>
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
  const savedUsageText = getSavedUsageText(count);

  return `
    <section class="saved-section menu-saved-section" aria-label="Saved songs">
      <div class="saved-heading">
        <div>
          <h2>Saved Songs</h2>
          <p>${escapeHtml(savedUsageText)}</p>
        </div>
        <span class="saved-language">${getPlanLabel()}</span>
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
                      <button class="saved-edit" type="button" data-action="edit-saved-list" data-index="${index}" title="Edit saved song" aria-label="Edit saved song">Edit</button>
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

function renderDeleteConfirmationDialog() {
  const item = state.savedTranslations.find((savedItem) => savedItem.id === state.pendingDeleteSavedTranslationId);

  if (!item) {
    return "";
  }

  const title = savedSongTitle(item);
  const artist = savedSongArtist(item);

  return `
    <div class="dialog-backdrop" role="presentation">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-song-title">
        <div class="confirm-dialog-heading">
          <h2 id="delete-song-title">Delete saved song?</h2>
          <p>${escapeHtml(title)} by ${escapeHtml(artist)} will be removed from your saved songs.</p>
        </div>
        <div class="confirm-dialog-actions">
          <button class="secondary-action ghost-action" type="button" data-action="cancel-delete-saved">
            <span>Cancel</span>
          </button>
          <button class="secondary-action delete-confirm-action" type="button" data-action="confirm-delete-saved">
            <span>Delete</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderLanguageControls() {
  return `
    <div class="segmented language-controls" aria-label="Language">
      <button class="${state.language === "mandarin" ? "active" : ""}" type="button" data-action="language" data-language="mandarin">
        Mandarin
      </button>
      <button class="${state.language === "cantonese" ? "active" : ""}" type="button" data-action="language" data-language="cantonese">
        Cantonese
      </button>
    </div>
  `;
}

function renderSearchActions() {
  const saveTitle = isPremiumPlan()
    ? "Save translation"
    : `Save translation (${state.savedTranslations.length}/${FREE_SAVE_LIMIT})`;

  return `
    <div class="panel-actions" aria-label="Lyric controls">
      <div class="actions search-actions">
        <button class="icon-button" type="button" data-action="menu" title="Main menu" aria-label="Main menu">←</button>
        <button class="icon-button" type="button" data-action="sample" title="Load sample" aria-label="Load sample">↻</button>
        <button class="icon-button save-action" type="button" data-action="save" title="${escapeHtml(saveTitle)}" aria-label="${escapeHtml(saveTitle)}">Save</button>
        <button class="icon-button" type="button" data-action="copy" title="Copy result" aria-label="Copy result">⧉</button>
        <button class="icon-button" type="button" data-action="download" title="Download result" aria-label="Download result">↓</button>
        <button class="icon-button danger" type="button" data-action="clear" title="Clear lyrics" aria-label="Clear lyrics">×</button>
      </div>
    </div>
  `;
}

function renderOutputPanel({
  showLanguageControls = false,
  showSearchActions = false,
  editableTranslations = false,
  showEditHeadingAction = false
} = {}) {
  const lines = getLines();
  const label = romanizationLabel();
  const translationPlaceholder = isTranslating ? "Translating..." : "Translation pending";

  return `
    ${showSearchActions ? renderSearchActions() : ""}
    ${showLanguageControls ? renderLanguageControls() : ""}

    <div class="output-heading">
      <div>
        <h2>Lines</h2>
        <p>${label}</p>
      </div>
      ${
        showEditHeadingAction
          ? `<button class="heading-edit-button" type="button" data-action="edit-saved" title="Edit saved song" aria-label="Edit saved song">Edit</button>`
          : `<span class="heading-icon">Aa</span>`
      }
    </div>

    ${
      lines.length
        ? `<div class="line-list">
            ${lines
              .map(
                (line, index) => `
                  <article class="lyric-card${editableTranslations ? " editable-lyric-card" : ""}">
                    <div class="line-number">${String(index + 1).padStart(2, "0")}</div>
                    <div class="line-content">
                      <p class="original">${escapeHtml(line.original)}</p>
                      <p class="romanization">${escapeHtml(line.romanization)}</p>
                      ${
                        editableTranslations
                          ? `<label class="translation-edit">
                              <span>English</span>
                              <textarea
                                data-translation-index="${index}"
                                spellcheck="true"
                                autocapitalize="sentences"
                                placeholder="${escapeHtml(translationPlaceholder)}"
                              >${escapeHtml(line.english)}</textarea>
                            </label>`
                          : `<p class="${line.english ? "english" : "english muted"}">${escapeHtml(line.english || translationPlaceholder)}</p>`
                      }
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
    const isSavedEdit = state.screen === "detail" && state.isEditingSavedTranslation;
    outputPanel.innerHTML = renderOutputPanel({
      showLanguageControls: state.screen === "search" || isSavedEdit,
      showSearchActions: state.screen === "search",
      editableTranslations: isSavedEdit,
      showEditHeadingAction: state.screen === "detail" && !state.isEditingSavedTranslation
    });
  }
  refreshStatus();
  bindContainedScrollAreas();
}

function containScrollDelta(event, element, deltaY) {
  const maxScrollTop = element.scrollHeight - element.clientHeight;

  if (maxScrollTop <= 1 || deltaY === 0) {
    return;
  }

  const nextScrollTop = element.scrollTop + deltaY;

  if (nextScrollTop < 0 || nextScrollTop > maxScrollTop) {
    element.scrollTop = Math.min(maxScrollTop, Math.max(0, nextScrollTop));
    event.preventDefault();
  }

  event.stopPropagation();
}

function handleContainedWheel(event) {
  containScrollDelta(event, event.currentTarget, event.deltaY);
}

function handleContainedTouchStart(event) {
  touchStartByElement.set(event.currentTarget, event.touches[0]?.clientY || 0);
}

function handleContainedTouchMove(event) {
  const element = event.currentTarget;
  const currentY = event.touches[0]?.clientY || 0;
  const previousY = touchStartByElement.get(element) || currentY;

  touchStartByElement.set(element, currentY);
  containScrollDelta(event, element, previousY - currentY);
}

function bindContainedScrollAreas() {
  root.querySelectorAll(containedScrollSelector).forEach((element) => {
    element.addEventListener("wheel", handleContainedWheel, { passive: false });
    element.addEventListener("touchstart", handleContainedTouchStart, { passive: true });
    element.addEventListener("touchmove", handleContainedTouchMove, { passive: false });
  });
}

function clearSearchResultsView() {
  const searchResults = root.querySelector(".search-results");
  if (searchResults) {
    searchResults.remove();
  }
}

function renderPremiumTopbarButton() {
  const isPremium = isPremiumPlan();
  const label = isPremium ? "Premium" : "Get Premium";
  const title = isPremium ? "Premium is active" : "Get Premium";

  return `
    <button
      class="premium-topbar-button${isPremium ? " premium" : ""}${state.screen === "payment" ? " active" : ""}"
      type="button"
      data-action="payment"
      title="${escapeHtml(title)}"
      aria-label="${escapeHtml(title)}"
    >
      ${isPremium ? `<span class="premium-check" aria-hidden="true">✓</span>` : ""}
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderTopbar({
  subtitle = `${romanizationLabel()} and English`,
  statusText = getStatusText(),
  statusIcon = getStatusIcon(),
  premiumControl = false
} = {}) {
  const accountTitle = `Account: ${getPlanLabel()}`;

  return `
    <header class="topbar">
      <button class="brand brand-home-button" type="button" data-action="menu" title="Main menu" aria-label="Main menu">
        <img class="brand-mark" src="/icon.svg" alt="" />
        <div>
          <h1>Lyric Lens</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </button>

      <div class="topbar-actions">
        ${
          premiumControl
            ? renderPremiumTopbarButton()
            : `<div class="status-strip" role="status">
                <span class="status-icon">${escapeHtml(statusIcon)}</span>
                <span class="status-text">${escapeHtml(statusText)}</span>
              </div>`
        }
        <button
          class="icon-button account-icon-button${state.screen === "account" ? " active" : ""}"
          type="button"
          data-action="account"
          title="${escapeHtml(accountTitle)}"
          aria-label="${escapeHtml(accountTitle)}"
        >
          <span class="account-glyph" aria-hidden="true"></span>
        </button>
      </div>
    </header>
  `;
}

function getAccountBackLabel() {
  if (state.accountReturnScreen === "search") {
    return "Lyrics";
  }

  if (state.accountReturnScreen === "detail") {
    return "Saved Song";
  }

  if (state.accountReturnScreen === "payment") {
    return "Premium";
  }

  return "Main Menu";
}

function renderAccountPage() {
  const planLabel = getPlanLabel();
  const planDescription = isPremiumPlan()
    ? "Premium account with unlimited saved translations."
    : `Free account with up to ${FREE_SAVE_LIMIT} saved translations.`;
  const syncStatus =
    state.auth.status === "signed-in"
      ? state.auth.email || "Signed in"
      : state.auth.status === "signed-out"
        ? "Not signed in"
        : state.auth.status === "loading"
          ? "Checking sync"
          : state.auth.message || "Local saves only";

  root.innerHTML = `
    <main class="app-shell account-shell">
      ${renderTopbar({
        subtitle: "Account",
        statusText: `${planLabel} account`,
        statusIcon: "i",
        premiumControl: true
      })}

      <section class="toolbar" aria-label="Account navigation">
        <button class="secondary-action home-action" type="button" data-action="account-back">
          <span class="button-icon">←</span>
          <span>${escapeHtml(getAccountBackLabel())}</span>
        </button>
      </section>

      <section class="account-page" aria-label="Account details">
        <section class="account-summary">
          <div class="account-summary-heading">
            <div>
              <h2>Account Type</h2>
              <p>${escapeHtml(planDescription)}</p>
            </div>
            <span class="account-plan-badge">${escapeHtml(planLabel)}</span>
          </div>

          <div class="account-detail-list">
            <div class="account-detail-row">
              <span>Status</span>
              <strong>${escapeHtml(syncStatus)}</strong>
            </div>
            <div class="account-detail-row">
              <span>Saved songs</span>
              <strong>${escapeHtml(getSavedUsageText())}</strong>
            </div>
          </div>

          ${
            isPremiumPlan()
              ? ""
              : `<button class="secondary-action account-upgrade-action" type="button" data-action="payment">
                  <span>Get Premium</span>
                </button>`
          }
        </section>

        ${renderAuthPanel()}
      </section>
    </main>
  `;
}

function getPaymentBackLabel() {
  if (state.paymentReturnScreen === "search") {
    return "Lyrics";
  }

  if (state.paymentReturnScreen === "detail") {
    return "Saved Song";
  }

  if (state.paymentReturnScreen === "account") {
    return "Account";
  }

  return "Main Menu";
}

function isStripeCheckoutUrl(url) {
  return url.hostname === "buy.stripe.com" || url.hostname === "checkout.stripe.com";
}

function getPremiumCheckoutUrl() {
  const checkoutUrl = state.config.premiumCheckoutUrl;
  if (!checkoutUrl) {
    return "";
  }

  try {
    const url = new URL(checkoutUrl, window.location.href);
    if (isStripeCheckoutUrl(url)) {
      if (state.auth.user?.id) {
        url.searchParams.set("client_reference_id", state.auth.user.id);
      }
      if (state.auth.email) {
        url.searchParams.set("prefilled_email", state.auth.email);
      }
    } else {
      if (state.auth.user?.id) {
        url.searchParams.set("user_id", state.auth.user.id);
      }
      if (state.auth.email) {
        url.searchParams.set("email", state.auth.email);
      }
      url.searchParams.set("return_url", window.location.href);
    }
    return url.toString();
  } catch {
    return checkoutUrl;
  }
}

function renderPaymentPage() {
  const isPremium = isPremiumPlan();
  const checkoutUrl = getPremiumCheckoutUrl();
  const isSignedIn = state.auth.status === "signed-in";
  const canCheckout = !isPremium && isSignedIn && Boolean(checkoutUrl);
  const savedUsageText = getSavedUsageText();
  const checkoutStatus = isPremium
    ? "Premium is active."
    : !checkoutUrl
      ? "Payment is not connected yet."
      : isSignedIn
        ? "Ready for secure checkout."
        : "Sign in before checkout.";
  const primaryCheckoutLabel = isPremium
    ? "Premium active"
    : !isSignedIn
      ? "Sign in to continue"
      : checkoutUrl
        ? "Continue to checkout"
        : "Checkout unavailable";

  root.innerHTML = `
    <main class="app-shell payment-shell">
      ${renderTopbar({
        subtitle: "Premium",
        statusText: getPremiumStatusText(),
        statusIcon: isPremium ? "✓" : "$",
        premiumControl: true
      })}

      <section class="toolbar" aria-label="Premium navigation">
        <button class="secondary-action home-action" type="button" data-action="payment-back">
          <span class="button-icon">←</span>
          <span>${escapeHtml(getPaymentBackLabel())}</span>
        </button>
      </section>

      <section class="payment-page" aria-label="Premium checkout">
        <section class="premium-summary">
          <div class="premium-summary-heading">
            <div>
              <h2>Premium</h2>
              <p>Keep every translated song in your cloud library.</p>
            </div>
            <span class="premium-plan-badge${isPremium ? " active" : ""}">
              ${isPremium ? "✓ Active" : "Upgrade"}
            </span>
          </div>

          <div class="premium-price-card">
            <span>Plan</span>
            <strong>${isPremium ? "Active" : "Unlimited saves"}</strong>
            <p>${isPremium ? "Your account already has premium access." : "Upgrade when you are ready to keep more than the free limit."}</p>
          </div>

          <ul class="premium-feature-list">
            <li><span class="feature-check">✓</span><span>Unlimited saved songs</span></li>
            <li><span class="feature-check">✓</span><span>Cloud library across devices</span></li>
            <li><span class="feature-check">✓</span><span>Mandarin and Cantonese study library</span></li>
            <li><span class="feature-check">✓</span><span>Customisable layouts (coming soon)</span></li>
          </ul>
        </section>

        <section class="checkout-panel" aria-label="Payment">
          <div class="checkout-heading">
            <h2>${isPremium ? "You're Premium" : "Checkout"}</h2>
            <p>${escapeHtml(checkoutStatus)}</p>
          </div>

          <div class="account-detail-list">
            <div class="account-detail-row">
              <span>Account</span>
              <strong>${escapeHtml(isSignedIn ? state.auth.email || "Signed in" : "Not signed in")}</strong>
            </div>
            <div class="account-detail-row">
              <span>Plan</span>
              <strong>${escapeHtml(getPlanLabel())}</strong>
            </div>
            <div class="account-detail-row">
              <span>Saved songs</span>
              <strong>${escapeHtml(savedUsageText)}</strong>
            </div>
          </div>

          <ol class="checkout-steps" aria-label="Checkout steps">
            <li class="${isSignedIn ? "complete" : "current"}">
              <span>1</span>
              <strong>Sign in</strong>
            </li>
            <li class="${isPremium ? "complete" : isSignedIn ? "current" : ""}">
              <span>2</span>
              <strong>Checkout</strong>
            </li>
            <li class="${isPremium ? "complete" : ""}">
              <span>3</span>
              <strong>Refresh</strong>
            </li>
          </ol>

          ${
            isPremium
              ? `<div class="checkout-actions">
                  <button class="secondary-action checkout-action" type="button" data-action="refresh-plan" ${state.auth.busy ? "disabled" : ""}>
                    <span>${state.auth.busy ? "Checking" : "Refresh account"}</span>
                  </button>
                </div>`
              : `<div class="checkout-actions">
                  <button class="secondary-action checkout-action" type="button" data-action="start-payment" ${canCheckout ? "" : "disabled"}>
                    <span>${escapeHtml(primaryCheckoutLabel)}</span>
                  </button>
                  <button class="secondary-action ghost-action checkout-action" type="button" data-action="refresh-plan" ${isSignedIn && !state.auth.busy ? "" : "disabled"}>
                    <span>${state.auth.busy ? "Checking" : "Refresh account"}</span>
                  </button>
                </div>`
          }

          ${state.paymentMessage ? `<p class="payment-message">${escapeHtml(state.paymentMessage)}</p>` : ""}
        </section>

        ${isSignedIn ? "" : renderAuthPanel()}
      </section>
    </main>
  `;
}

function renderMenu() {
  root.innerHTML = `
    <main class="app-shell menu-shell">
      ${renderTopbar({
        subtitle: "Saved songs",
        statusText: getPremiumStatusText(),
        statusIcon: isPremiumPlan() ? "✓" : "$",
        premiumControl: true
      })}

      <section class="menu-actions" aria-label="Search options">
        <button class="menu-search-button" type="button" data-action="start-search" data-search-mode="song">
          <span>Search for Song</span>
        </button>
        <button class="menu-search-button" type="button" data-action="start-search" data-search-mode="custom">
          <span>Custom</span>
        </button>
      </section>

      ${renderAuthPanel()}
      ${renderSavedSongs()}
    </main>
  `;
}

function renderSavedEditForm() {
  return `
    <div class="input-panel saved-edit-panel">
      <div class="custom-meta-box">
        <label>
          <span>Song name</span>
          <input
            value="${escapeHtml(state.title)}"
            data-field="title"
            autocomplete="off"
            autocapitalize="off"
            placeholder=""
          />
        </label>
        <label>
          <span>Artist</span>
          <input
            value="${escapeHtml(state.artist)}"
            data-field="artist"
            autocomplete="off"
            autocapitalize="off"
            placeholder=""
          />
        </label>
      </div>

      <label class="lyrics-box saved-edit-lyrics">
        <span>Lyrics</span>
        <textarea
          data-field="lyrics"
          spellcheck="false"
          autocapitalize="off"
          placeholder="Paste your lyrics here"
        >${escapeHtml(state.lyrics)}</textarea>
      </label>
    </div>
  `;
}

function renderSavedDetail() {
  const title = state.title || splitLyrics(state.lyrics)[0] || "Saved song";
  const isEditing = state.isEditingSavedTranslation;
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

        ${
          isEditing
            ? `<div class="actions compact-actions saved-detail-actions">
                <button class="secondary-action edit-action save-edit-action" type="button" data-action="save-saved-edit">
                  <span>Save changes</span>
                </button>
                <button class="secondary-action ghost-action edit-action" type="button" data-action="cancel-saved-edit">
                  <span>Cancel</span>
                </button>
              </div>`
            : ""
        }
      </section>

      <section class="${isEditing ? "detail-workspace saved-edit-workspace" : "detail-workspace"}">
        ${isEditing ? renderSavedEditForm() : ""}
        <div class="output-panel" aria-label="Translated lyrics">
          ${renderOutputPanel({
            showLanguageControls: isEditing,
            editableTranslations: isEditing,
            showEditHeadingAction: !isEditing
          })}
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

      <section class="${isCustomMode ? "workspace custom-workspace" : "workspace"}">
        <div class="${isCustomMode ? "input-panel custom-input-panel" : "input-panel"}">
          <div class="${isCustomMode ? "search-panel custom-search-panel" : "search-panel"}">
            ${
              isCustomMode
                ? ""
                : `<div class="segmented search-mode" aria-label="Search type">
                    <button class="${state.searchMode === "song" ? "active" : ""}" type="button" data-action="search-mode" data-search-mode="song">
                      Song
                    </button>
                    <button class="${state.searchMode === "artist" ? "active" : ""}" type="button" data-action="search-mode" data-search-mode="artist">
                      Artist
                    </button>
                  </div>`
            }

            ${
              isCustomMode
                ? `<div class="custom-meta-box">
                    <label>
                      <span>Song name</span>
                      <input
                        value="${escapeHtml(state.title)}"
                        data-field="title"
                        autocomplete="off"
                        autocapitalize="off"
                        placeholder=""
                      />
                    </label>
                    <label>
                      <span>Artist</span>
                      <input
                        value="${escapeHtml(state.artist)}"
                        data-field="artist"
                        autocomplete="off"
                        autocapitalize="off"
                        placeholder=""
                      />
                    </label>
                  </div>

                  <label class="custom-lyrics-box">
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
                      placeholder=""
                    />
                  </label>`
            }

            ${
              isCustomMode
                ? ""
                : `<button class="secondary-action" type="button" data-action="search">
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
          ${renderOutputPanel({ showLanguageControls: true, showSearchActions: true })}
        </div>
      </section>
    </main>
  `;
}

function render() {
  if (state.screen === "menu") {
    renderMenu();
  } else if (state.screen === "detail") {
    renderSavedDetail();
  } else if (state.screen === "account") {
    renderAccountPage();
  } else if (state.screen === "payment") {
    renderPaymentPage();
  } else {
    renderSearchScreen();
  }

  const deleteDialog = renderDeleteConfirmationDialog();
  if (deleteDialog) {
    root.insertAdjacentHTML("beforeend", deleteDialog);
  }

  bindContainedScrollAreas();
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

async function saveCurrentTranslation() {
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

  if (existingIndex < 0 && !canAddSavedTranslation()) {
    setMessage(getSaveLimitMessage());
    return;
  }

  if (existingIndex >= 0) {
    savedItem.id = state.savedTranslations[existingIndex].id;
    state.savedTranslations.splice(existingIndex, 1);
  }

  state.savedTranslations.unshift(savedItem);
  state.savedTranslations = dedupeSavedTranslations(state.savedTranslations);
  saveSavedTranslations();

  if (isCloudSyncReady()) {
    const synced = await syncSavedTranslation(savedItem);
    setMessage(synced ? "Saved and synced." : "Saved on this device.");
    return;
  }

  setMessage(state.auth.status === "signed-out" ? "Saved on this device. Sign in to sync." : "Saved translation.");
}

function showMenu() {
  cancelAutoTranslate({ abort: true });
  state.screen = "menu";
  state.accountReturnScreen = "menu";
  state.currentSavedTranslationId = "";
  state.isEditingSavedTranslation = false;
  state.pendingDeleteSavedTranslationId = "";
  state.message = "";
  render();
}

function showAccount() {
  if (state.screen !== "account") {
    state.accountReturnScreen = ["menu", "search", "detail", "payment"].includes(state.screen) ? state.screen : "menu";
  }

  state.screen = "account";
  state.message = "";
  render();
}

function returnFromAccount() {
  state.screen = ["menu", "search", "detail", "payment"].includes(state.accountReturnScreen)
    ? state.accountReturnScreen
    : "menu";
  state.message = "";
  render();
}

function showPayment() {
  if (state.screen !== "payment") {
    state.paymentReturnScreen = ["menu", "search", "detail", "account"].includes(state.screen) ? state.screen : "menu";
  }

  state.screen = "payment";
  state.paymentMessage = "";
  state.message = "";
  render();
}

function returnFromPayment() {
  state.screen = ["menu", "search", "detail", "account"].includes(state.paymentReturnScreen)
    ? state.paymentReturnScreen
    : "menu";
  state.paymentMessage = "";
  state.message = "";
  render();
}

function startPremiumCheckout() {
  const checkoutUrl = getPremiumCheckoutUrl();
  if (!checkoutUrl || state.auth.status !== "signed-in" || isPremiumPlan()) {
    return;
  }

  window.location.assign(checkoutUrl);
}

async function refreshAccountPlan() {
  if (!supabaseClient || !state.auth.user || state.auth.busy) {
    state.paymentMessage = "Sign in to refresh your account.";
    render();
    return;
  }

  state.auth.busy = true;
  state.paymentMessage = "Checking your account...";
  render();

  await loadAccountPlan(state.auth.user);
  enforceSavedTranslationLimit();

  state.auth.busy = false;
  state.paymentMessage = isPremiumPlan() ? "Premium is active." : "Premium is not active yet.";
  render();
}

function findSavedTranslationIndexById(id = state.currentSavedTranslationId) {
  return state.savedTranslations.findIndex((item) => item.id === id);
}

function startSearch(mode) {
  cancelAutoTranslate({ abort: true });
  state.screen = "search";
  state.currentSavedTranslationId = "";
  state.isEditingSavedTranslation = false;
  state.searchMode = ["artist", "custom"].includes(mode) ? mode : "song";
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
  state.currentSavedTranslationId = savedItem.id;
  state.isEditingSavedTranslation = false;
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

function openSavedTranslationForEdit(index) {
  openSavedTranslation(index);
  if (state.screen === "detail") {
    state.isEditingSavedTranslation = true;
    state.message = "Editing saved song.";
    render();
  }
}

function editSavedTranslation() {
  if (findSavedTranslationIndexById() < 0) {
    setMessage("Saved song not found.");
    return;
  }

  state.isEditingSavedTranslation = true;
  state.message = "Editing saved song.";
  render();
}

function cancelSavedTranslationEdit() {
  const savedIndex = findSavedTranslationIndexById();
  if (savedIndex < 0) {
    showMenu();
    return;
  }

  openSavedTranslation(savedIndex);
}

async function saveSavedTranslationEdit() {
  const savedIndex = findSavedTranslationIndexById();
  if (savedIndex < 0) {
    setMessage("Saved song not found.");
    return;
  }

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

  const previousItem = state.savedTranslations[savedIndex];
  const updatedItem = {
    ...previousItem,
    savedAt: new Date().toISOString(),
    language: state.language,
    searchMode: state.searchMode,
    searchQuery: state.searchQuery,
    title: state.title.trim(),
    artist: state.artist.trim(),
    lyrics: state.lyrics.trim(),
    translations: normalizeTranslationList(state.translations, lyricLines.length)
  };
  const updatedKey = getSavedTranslationKey(updatedItem);
  const duplicateItems = state.savedTranslations.filter(
    (item, index) => index !== savedIndex && getSavedTranslationKey(item) === updatedKey
  );

  state.savedTranslations = state.savedTranslations.filter(
    (item, index) => index !== savedIndex && getSavedTranslationKey(item) !== updatedKey
  );
  state.savedTranslations.unshift(updatedItem);
  saveSavedTranslations();

  if (isCloudSyncReady()) {
    for (const item of duplicateItems) {
      await deleteCloudSavedTranslation(item);
    }
    const synced = await syncSavedTranslation(updatedItem);
    state.isEditingSavedTranslation = false;
    state.message = synced ? "Saved changes and synced." : "Saved changes on this device.";
    render();
    saveDraft();
    return;
  }

  state.isEditingSavedTranslation = false;
  setMessage(state.auth.status === "signed-out" ? "Saved changes on this device. Sign in to sync." : "Saved changes.");
}

async function deleteSavedTranslation(index) {
  if (!state.savedTranslations[index]) {
    return;
  }

  const [removedItem] = state.savedTranslations.splice(index, 1);
  saveSavedTranslations();
  await deleteCloudSavedTranslation(removedItem);
  setMessage("Removed saved translation.");
}

function requestDeleteSavedTranslation(index) {
  const savedItem = state.savedTranslations[index];
  if (!savedItem) {
    return;
  }

  state.pendingDeleteSavedTranslationId = savedItem.id;
  render();
}

function cancelDeleteSavedTranslation() {
  state.pendingDeleteSavedTranslationId = "";
  render();
}

async function confirmDeleteSavedTranslation() {
  const savedItemId = state.pendingDeleteSavedTranslationId;
  const index = state.savedTranslations.findIndex((savedItem) => savedItem.id === savedItemId);
  state.pendingDeleteSavedTranslationId = "";
  await deleteSavedTranslation(index);
}

function handleInput(event) {
  const authField = event.target.dataset.authField;
  if (authField) {
    state.auth[authField] = event.target.value;
    state.auth.message = "";
    return;
  }

  const translationIndex = event.target.dataset.translationIndex;
  if (translationIndex !== undefined) {
    const index = Number(translationIndex);
    if (Number.isInteger(index) && index >= 0) {
      state.translations[index] = event.target.value;
      state.message = "";
      refreshStatus();
      saveDraft();
    }
    return;
  }

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

  if (action === "account") {
    showAccount();
  }

  if (action === "account-back") {
    returnFromAccount();
  }

  if (action === "payment") {
    showPayment();
  }

  if (action === "payment-back") {
    returnFromPayment();
  }

  if (action === "start-payment") {
    startPremiumCheckout();
  }

  if (action === "refresh-plan") {
    refreshAccountPlan();
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
    state.searchMode = nextMode === "artist" ? "artist" : "song";
    state.searchQuery = "";
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

  if (action === "edit-saved") {
    editSavedTranslation();
  }

  if (action === "cancel-saved-edit") {
    cancelSavedTranslationEdit();
  }

  if (action === "save-saved-edit") {
    saveSavedTranslationEdit();
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

  if (action === "edit-saved-list") {
    openSavedTranslationForEdit(Number(button.dataset.index));
  }

  if (action === "delete-saved") {
    requestDeleteSavedTranslation(Number(button.dataset.index));
  }

  if (action === "cancel-delete-saved") {
    cancelDeleteSavedTranslation();
  }

  if (action === "confirm-delete-saved") {
    confirmDeleteSavedTranslation();
  }

  if (action === "auth-sign-in") {
    signInToCloud();
  }

  if (action === "auth-sign-up") {
    createCloudAccount();
  }

  if (action === "auth-sign-out") {
    signOutFromCloud();
  }
}

function handleKeyDown(event) {
  if (event.key === "Escape" && state.pendingDeleteSavedTranslationId) {
    cancelDeleteSavedTranslation();
  }
}

root.addEventListener("input", handleInput);
root.addEventListener("compositionstart", handleCompositionStart);
root.addEventListener("compositionend", handleCompositionEnd);
root.addEventListener("click", handleClick);
window.addEventListener("keydown", handleKeyDown);

loadDraft();
loadSavedTranslations();
render();
initializeCloudSync();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
