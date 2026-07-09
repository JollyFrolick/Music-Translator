import { createHmac, timingSafeEqual } from "node:crypto";

const maxBodyBytes = 1_000_000;
const appUserAgent = "Lyric Lens/0.1 hosted PWA";
const myMemoryMaxChars = 450;
const stripeWebhookToleranceSeconds = 5 * 60;
const stripeCheckoutCompleteEvents = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded"
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  if (Buffer.isBuffer(request.body)) {
    return Promise.resolve(request.body.toString("utf8"));
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

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
}

function getSupabaseAnonKey() {
  return (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ""
  );
}

function getPremiumCheckoutUrl() {
  return (
    process.env.PREMIUM_CHECKOUT_URL ||
    process.env.NEXT_PUBLIC_PREMIUM_CHECKOUT_URL ||
    process.env.VITE_PREMIUM_CHECKOUT_URL ||
    ""
  );
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || "";
}

function getSupabaseServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function parseStripeSignatureHeader(signatureHeader) {
  const parsed = { timestamp: 0, signatures: [] };

  String(signatureHeader || "")
    .split(",")
    .forEach((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();

      if (key === "t") {
        parsed.timestamp = Number(value);
      }
      if (key === "v1" && value) {
        parsed.signatures.push(value);
      }
    });

  return parsed;
}

function timingSafeEqualHex(first, second) {
  if (!/^[0-9a-f]+$/i.test(first) || !/^[0-9a-f]+$/i.test(second) || first.length !== second.length) {
    return false;
  }

  const firstBuffer = Buffer.from(first, "hex");
  const secondBuffer = Buffer.from(second, "hex");
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}

function verifyStripeWebhookPayload(payload, signatureHeader, endpointSecret) {
  if (!endpointSecret) {
    const error = new Error("Stripe webhook is not configured.");
    error.status = 500;
    throw error;
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (!timestamp || !signatures.length) {
    const error = new Error("Missing Stripe signature.");
    error.status = 400;
    throw error;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > stripeWebhookToleranceSeconds) {
    const error = new Error("Stripe signature timestamp is too old.");
    error.status = 400;
    throw error;
  }

  const expectedSignature = createHmac("sha256", endpointSecret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  const verified = signatures.some((signature) => timingSafeEqualHex(signature, expectedSignature));

  if (!verified) {
    const error = new Error("Stripe signature verification failed.");
    error.status = 400;
    throw error;
  }

  return JSON.parse(payload);
}

function getCheckoutSessionUserId(session) {
  const clientReferenceId = typeof session?.client_reference_id === "string" ? session.client_reference_id.trim() : "";
  const metadataUserId = typeof session?.metadata?.user_id === "string" ? session.metadata.user_id.trim() : "";
  const userId = clientReferenceId || metadataUserId;
  return uuidPattern.test(userId) ? userId : "";
}

function isPaidCheckoutSession(session) {
  return session?.payment_status === "paid" || session?.payment_status === "no_payment_required";
}

async function markUserPremium(userId) {
  const supabaseUrl = getSupabaseUrl();
  const serviceRoleKey = getSupabaseServiceRoleKey();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service role is not configured.");
  }

  const profilesUrl = new URL("/rest/v1/profiles", supabaseUrl);
  profilesUrl.searchParams.set("on_conflict", "user_id");

  const apiResponse = await fetch(profilesUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      user_id: userId,
      plan: "premium",
      updated_at: new Date().toISOString()
    })
  });

  if (!apiResponse.ok) {
    const message = await apiResponse.text();
    throw new Error(message || "Could not update Supabase profile.");
  }
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

export async function handleStripeWebhook(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  let event;

  try {
    const payload = await readBody(request);
    const signature = request.headers["stripe-signature"];
    event = verifyStripeWebhookPayload(payload, signature, getStripeWebhookSecret());
  } catch (error) {
    console.error(error);
    return sendJson(response, error.status || 400, { error: error.message || "Invalid Stripe webhook." });
  }

  if (!stripeCheckoutCompleteEvents.has(event.type)) {
    return sendJson(response, 200, { received: true, ignored: true });
  }

  const session = event.data?.object;
  if (!isPaidCheckoutSession(session)) {
    return sendJson(response, 200, { received: true, ignored: true });
  }

  const userId = getCheckoutSessionUserId(session);
  if (!userId) {
    console.warn("Stripe checkout session completed without a Supabase user ID.");
    return sendJson(response, 200, { received: true, ignored: true });
  }

  try {
    await markUserPremium(userId);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "Could not update Premium status." });
  }

  return sendJson(response, 200, { received: true, premium: true });
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

  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  const premiumCheckoutUrl = getPremiumCheckoutUrl();

  return sendJson(response, 200, {
    cloudSyncEnabled: Boolean(supabaseUrl && supabaseAnonKey),
    supabaseUrl,
    supabaseAnonKey,
    premiumCheckoutUrl
  });
}
