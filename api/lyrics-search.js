import { handleLyricsSearch } from "../lib/api-handlers.js";

export default function handler(request, response) {
  return handleLyricsSearch(request, response);
}
