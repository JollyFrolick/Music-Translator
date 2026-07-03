import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const root = fileURLToPath(new URL(".", import.meta.url));
const defaultPort = 5173;
const requestedPort = Number(process.env.PORT || defaultPort);
const host = "0.0.0.0";
const maxBodyBytes = 1_000_000;
const appUserAgent = "Lyric Lens/0.1 local PWA";
const portRetryLimit = 10;

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  console.error("PORT must be a number from 1 to 65535.");
  process.exit(1);
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

if (process.argv.includes("--check")) {
  await Promise.all([
    readFile(join(root, "index.html")),
    readFile(join(root, "src", "main.js")),
    readFile(join(root, "src", "styles.css")),
    readFile(join(root, "public", "manifest.webmanifest")),
    readFile(join(root, "public", "sw.js")),
    readFile(join(root, "public", "icon.svg"))
  ]);
  console.log("Static app files are present.");
  process.exit(0);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function handleTranslate(request, response) {
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

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(response, 503, {
      error: "Translation is offline. Add OPENAI_API_KEY to enable it."
    });
  }

  try {
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
      return sendJson(response, apiResponse.status, {
        error: data.error?.message || "Translation failed."
      });
    }

    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const translations = Array.isArray(parsed.translations) ? parsed.translations : [];

    return sendJson(response, 200, {
      translations: lines.map((_, index) =>
        typeof translations[index] === "string" ? translations[index] : ""
      )
    });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "Translation failed. Try again in a moment." });
  }
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

async function handleLyricsSearch(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
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

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const publicPath = pathname.startsWith("/src/")
    ? join(root, pathname)
    : pathname === "/index.html"
      ? join(root, "index.html")
      : join(root, "public", pathname);

  const safePath = normalize(publicPath);
  if (!safePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(safePath);
    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(safePath)] || "application/octet-stream"
    });
    createReadStream(safePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function getLanUrls(activePort) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => `http://${net.address}:${activePort}`);
}

const requestHandler = async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (request.method === "POST" && url.pathname === "/api/translate") {
    await handleTranslate(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/lyrics-search") {
    await handleLyricsSearch(request, response);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response);
    return;
  }

  response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Method not allowed");
};

function listenOnPort(activePort) {
  const server = createServer(requestHandler);

  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      if (error.code === "EADDRINUSE") {
        resolve({ occupied: true, port: activePort });
        return;
      }

      reject(error);
    };

    server.once("error", handleError);
    server.listen(activePort, host, () => {
      server.off("error", handleError);
      resolve({ occupied: false, port: activePort, server });
    });
  });
}

async function startServer() {
  const shouldRetryPort = !process.env.PORT;

  for (let nextPort = requestedPort; nextPort <= requestedPort + portRetryLimit; nextPort += 1) {
    const result = await listenOnPort(nextPort);
    if (result.occupied) {
      if (!shouldRetryPort) {
        console.error(`Port ${requestedPort} is already in use.`);
        console.error(`Stop the other server or run with a different port, like PORT=${requestedPort + 1} npm run dev.`);
        process.exit(1);
      }
      continue;
    }

    if (nextPort !== requestedPort) {
      console.log(`Port ${requestedPort} is already in use, using ${nextPort} instead.`);
    }

    console.log(`Lyric Lens is running at http://localhost:${nextPort}`);
    for (const url of getLanUrls(nextPort)) {
      console.log(`iPhone on same Wi-Fi: ${url}`);
    }
    return result.server;
  }

  console.error(`Ports ${requestedPort}-${requestedPort + portRetryLimit} are already in use.`);
  console.error("Stop one of the running servers or set PORT to an open port.");
  process.exit(1);
}

await startServer();
