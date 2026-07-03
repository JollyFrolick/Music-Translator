# Lyric Lens

A small installable PWA for Chinese song lyrics. Search by song title or artist name, paste custom lyrics when needed, choose Mandarin or Cantonese, and the app shows line-by-line romanization plus English translation when an OpenAI API key is configured.

## Run Locally

```sh
npm run dev
```

Open the local URL printed by the server on your Mac. It normally uses:

```txt
http://localhost:5173
```

If that port is already in use, the server will choose the next open port and print that URL instead.

For iPhone testing, keep your Mac and iPhone on the same Wi-Fi, then open the LAN URL printed by the server in Safari. It will look like:

```txt
http://192.168.2.104:5173
```

In Safari, use Share -> Add to Home Screen to install it like an app.

## Enable Translation

Romanization works in the browser. Translation uses the local server so your API key is not stored in the phone app.

```sh
OPENAI_API_KEY=your_key_here npm run dev
```

Optional:

```sh
OPENAI_MODEL=gpt-4o-mini OPENAI_API_KEY=your_key_here npm run dev
```

## Notes

- Mandarin uses pinyin.
- Cantonese uses Jyutping.
- Song and artist search use LRCLIB. Availability depends on whether that database has the song.
- When no exact song or artist is found, the app shows similar songs or artist suggestions from LRCLIB results.
- Use Custom mode to paste lyrics manually when search does not find the track.
- This version avoids YouTube audio or unauthorized lyric extraction.
