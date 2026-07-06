const maxBodyBytes = 1_000_000;
const appUserAgent = "Lyric Lens/0.1 hosted PWA";
const myMemoryMaxChars = 450;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function getRequestUrl(request) {
  return new URL(request.url || "/", `http://${request.headers.host}`);
}

function decodeCodePoint(match, code, radix = 10) {
  const codePoint = parseInt(code, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, decodeCodePoint)
    .replace(/&#x([\da-f]+);/gi, (match, code) => decodeCodePoint(match, code, 16));
}

function normalizeTranslations(translations, lineCount) {
  return Array.from({ length: lineCount }, (_, index) =>
    typeof translations[index] === "string" ? decodeHtmlEntities(translations[index]).trim() : ""
  );
}

function hasCompleteTranslations(translations) {
  return translations.every((translation) => translation.trim());
}

function mergeTranslations(primary, fallback) {
  return primary.map((translation, index) => translation || fallback[index] || "");
}

function chunkLines(lines) {
  const chunks = [];
  let currentLines = [];
  let currentStart = 0;
  let currentLength = 0;

  lines.forEach((line, index) => {
    const separatorLength = currentLines.length ? 1 : 0;
    const nextLength = currentLength + separatorLength + line.length;

    if (currentLines.length && nextLength > myMemoryMaxChars) {
      chunks.push({ start: currentStart, lines: currentLines });
      currentLines = [];
      currentStart = index;
      currentLength = 0;
    }

    currentLength += (currentLines.length ? 1 : 0) + line.length;
    currentLines.push(line);
  });

  if (currentLines.length) {
    chunks.push({ start: currentStart, lines: currentLines });
  }

  return chunks;
}

function splitTranslatedText(value) {
  return decodeHtmlEntities(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fetchMyMemoryLines(lines, language) {
  const sourceLanguage = language === "cantonese" ? "zh-TW" : "zh-CN";
  const params = new URLSearchParams({
    q: lines.join("\n"),
    langpair: `${sourceLanguage}|en`
  });

  const apiResponse = await fetch(`https://api.mymemory.translated.net/get?${params}`, {
    headers: { "User-Agent": appUserAgent }
  });
  const data = await apiResponse.json();

  if (!apiResponse.ok || Number(data.responseStatus) >= 400) {
    throw new Error(data.responseDetails || "Fallback translation failed.");
  }

  const translatedText = data.responseData?.translatedText;
  if (typeof translatedText !== "string" || !translatedText.trim()) {
    throw new Error("Fallback translation returned no text.");
  }

  return splitTranslatedText(translatedText);
}

async function translateWithMyMemory(lines, language) {
  const translations = Array.from({ length: lines.length }, () => "");

  for (const chunk of chunkLines(lines)) {
    const translatedLines = await fetchMyMemoryLines(chunk.lines, language);

    if (translatedLines.length === chunk.lines.length) {
      translatedLines.forEach((translation, offset) => {
        translations[chunk.start + offset] = translation;
      });
      continue;
    }

    for (let offset = 0; offset < chunk.lines.length; offset += 1) {
      const [translation] = await fetchMyMemoryLines([chunk.lines[offset]], language);
      translations[chunk.start + offset] = translation || translatedLines[offset] || "";
    }
  }

  return normalizeTranslations(translations, lines.length);
}

async function translateWithOpenAI(lines, language) {
  const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Translate Chinese song lyric lines into natural English. Preserve the number and order of lines. Return only JSON in the shape {\"translations\":[\"...\"]}. Keep imagery and emotion, but avoid adding interpretation not present in the line."
        },
        {
          role: "user",
          content: JSON.stringify({
            language: language === "cantonese" ? "Cantonese" : "Mandarin",
            lines
          })
        }
      ]
    })
  });

  const data = await apiResponse.json();
  if (!apiResponse.ok) {
    throw new Error(data.error?.message || "OpenAI translation failed.");
  }

  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];
  return normalizeTranslations(translations, lines.length);
}

function readBody(request) {
  if (typeof request.body === "string") {
    return Promise.resolve(request.body);
  }

  if (request.body && typeof request.body === "object" && !request.readable) {
    return Promise.resolve(JSON.stringify(request.body));
  }

  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy?.();
        return;
      }
      body += chunk;
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export async function handleTranslate(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  let payload;

  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    return sendJson(response, 400, { error: "Invalid JSON request." });
  }

  const { lines, language } = payload ?? {};
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
    return sendJson(response, 400, { error: "Expected lines to be an array of strings." });
  }

  let translations = Array.from({ length: lines.length }, () => "");
  let provider = "";
  let openAiError = null;

  if (process.env.OPENAI_API_KEY) {
    try {
      translations = await translateWithOpenAI(lines, language);
      provider = "OpenAI";
    } catch (error) {
      openAiError = error;
      console.error(error);
    }
  }

  if (!hasCompleteTranslations(translations)) {
    try {
      const fallbackTranslations = await translateWithMyMemory(lines, language);
      translations = mergeTranslations(translations, fallbackTranslations);
      provider = provider ? `${provider} + MyMemory` : "MyMemory";
    } catch (error) {
      console.error(error);
      const message = openAiError
        ? "Translation failed. Check your OpenAI key or try again in a moment."
        : "Translation is temporarily unavailable. Try again in a moment.";
      return sendJson(response, openAiError ? 502 : 503, { error: message });
    }
  }

  if (!hasCompleteTranslations(translations)) {
    return sendJson(response, 502, {
      error: "Translation returned incomplete results. Try again in a moment."
    });
  }

  return sendJson(response, 200, { translations, provider });
}

function stripLrcTimestamps(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\[[0-9:.]+\]\s*)+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeLyricRecord(record) {
  const lyrics = record.plainLyrics || stripLrcTimestamps(record.syncedLyrics || "");

  return {
    id: record.id,
    title: record.trackName || record.name || "",
    artist: record.artistName || "",
    album: record.albumName || "",
    duration: typeof record.duration === "number" ? record.duration : null,
    instrumental: Boolean(record.instrumental),
    hasSyncedLyrics: Boolean(record.syncedLyrics),
    lyrics,
    preview: lyrics.split(/\r?\n/).filter(Boolean).slice(0, 2).join(" / ")
  };
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'’‘“”.,:;!?()[\]{}\-_/\\|]+/g, "");
}

function similarityScore(value, query) {
  const normalizedValue = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedValue || !normalizedQuery) {
    return 0;
  }
  if (normalizedValue === normalizedQuery) {
    return 100;
  }
  if (normalizedValue.includes(normalizedQuery)) {
    return 80 + Math.min(19, normalizedQuery.length);
  }

  const valueChars = [...normalizedValue];
  const queryChars = [...normalizedQuery];
  const overlap = queryChars.filter((char) => normalizedValue.includes(char)).length;
  return Math.round((overlap / Math.max(queryChars.length, valueChars.length)) * 70);
}

function isExactMatch(value, query) {
  const normalizedValue = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);
  return Boolean(
    normalizedValue &&
      normalizedQuery &&
      (normalizedValue === normalizedQuery || normalizedValue.includes(normalizedQuery))
  );
}

function getSimilarArtists(records, query) {
  const seen = new Set();
  return records
    .map((record) => ({
      name: record.artist,
      score: similarityScore(record.artist, query)
    }))
    .filter((artist) => artist.name)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .filter((artist) => {
      const key = normalizeSearchText(artist.name);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 6)
    .map((artist) => artist.name);
}

function getSearchVariants(query) {
  const variants = new Set([query]);
  const strippedAsciiSuffix = query.replace(/([\u3400-\u9fff])[\w.-]+$/u, "$1");
  variants.add(strippedAsciiSuffix);
  variants.add(query.replace(/[滴地得]/g, "的"));
  variants.add(query.replace(/[妳您]/g, "你"));
  variants.add(query.replace(/[愛]/g, "爱"));
  variants.add(query.replace(/[著]/g, "着"));
  return [...variants].map((value) => value.trim()).filter(Boolean);
}

async function fetchLrclibRecords(params) {
  const searchUrl = new URL("https://lrclib.net/api/search");
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      searchUrl.searchParams.set(key, value);
    }
  }

  const apiResponse = await fetch(searchUrl, {
    headers: { "User-Agent": appUserAgent }
  });
  const data = await apiResponse.json();

  if (!apiResponse.ok) {
    const error = new Error(data?.message || "Lyrics search failed.");
    error.status = apiResponse.status;
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

export async function handleLyricsSearch(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  const url = getRequestUrl(request);
  const title = (url.searchParams.get("title") || "").trim();
  const artist = (url.searchParams.get("artist") || "").trim();

  if (!title && !artist) {
    return sendJson(response, 400, { error: "Enter a song title or artist." });
  }
  if (title && artist) {
    return sendJson(response, 400, { error: "Search by song or artist, not both." });
  }

  try {
    const seen = new Set();
    const mode = title ? "song" : "artist";
    const query = title || artist;
    const strictRecords = await fetchLrclibRecords(title ? { track_name: title } : { q: artist });
    let records = strictRecords;
    let normalized = records
      .map(normalizeLyricRecord)
      .filter((record) => record.lyrics && !record.instrumental)
      .map((record) => {
        const target = mode === "artist" ? record.artist : record.title;
        return {
          ...record,
          isExact: isExactMatch(target, query),
          similarity: similarityScore(target, query)
        };
      })
      .sort((a, b) => {
        if (a.isExact !== b.isExact) {
          return a.isExact ? -1 : 1;
        }
        return b.similarity - a.similarity;
      });

    if (!normalized.some((record) => record.isExact)) {
      const fallbackRecords = [];
      for (const variant of getSearchVariants(query)) {
        fallbackRecords.push(...(await fetchLrclibRecords({ q: variant })));
        if (fallbackRecords.length >= 20) {
          break;
        }
      }

      records = [...strictRecords, ...fallbackRecords];
      normalized = records
        .map(normalizeLyricRecord)
        .filter((record) => record.lyrics && !record.instrumental)
        .map((record) => {
          const target = mode === "artist" ? record.artist : record.title;
          return {
            ...record,
            isExact: isExactMatch(target, query),
            similarity: similarityScore(target, query)
          };
        })
        .sort((a, b) => {
          if (a.isExact !== b.isExact) {
            return a.isExact ? -1 : 1;
          }
          return b.similarity - a.similarity;
        });
    }

    const results = normalized
      .filter((record) => {
        const key = `${record.title}|${record.artist}|${record.album}|${record.duration}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, 8);

    const exactCount = normalized.filter((record) => record.isExact).length;
    const similarArtists = mode === "artist" && exactCount === 0 ? getSimilarArtists(normalized, query) : [];

    return sendJson(response, 200, {
      results,
      meta: {
        mode,
        query,
        exactCount,
        showingSimilar: results.length > 0 && exactCount === 0,
        similarArtists
      }
    });
  } catch (error) {
    console.error(error);
    return sendJson(response, error.status || 500, {
      error: error.message || "Lyrics search failed. Try again in a moment."
    });
  }
}

export function handleConfig(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "";

  return sendJson(response, 200, {
    cloudSyncEnabled: Boolean(supabaseUrl && supabaseAnonKey),
    supabaseUrl,
    supabaseAnonKey
  });
}
