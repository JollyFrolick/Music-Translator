# Lyric Lens

A small installable PWA for Chinese song lyrics. Search by song title or artist name, paste custom lyrics when needed, choose Mandarin or Cantonese, and the app shows line-by-line romanization plus English translation.

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

## Deploy Online

### Vercel

This repo is ready for Vercel. Import the GitHub repo in Vercel and use:

```txt
Framework Preset: Other
Build Command: npm run build
Output Directory: dist
```

The browser app is served as static files, and these Vercel Functions handle server-only work:

```txt
/api/translate
/api/lyrics-search
/api/config
```

Add `OPENAI_API_KEY` as a Vercel environment variable if you want OpenAI translations. Without it, the app uses the fallback translator.

### Cloud Sync

Saved songs sync across devices when Supabase is configured.

1. Create a Supabase project.
2. In Supabase SQL Editor, run `supabase/schema.sql`.
3. In Vercel, add these environment variables:

```txt
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
PREMIUM_CHECKOUT_URL=your_payment_checkout_url
```

After redeploying, the app shows an Account panel on the home screen. Sign in on your phone and laptop to share the same saved-song library.

Free accounts can save up to 5 songs. The top-right Get Premium button opens the in-app payment page and uses `PREMIUM_CHECKOUT_URL` for checkout. Premium accounts can save without an app-level limit. To mark a signed-in user as premium, copy their user ID from Supabase Authentication -> Users, then run:

```sql
insert into public.profiles (user_id, plan)
values ('user-uuid-here', 'premium')
on conflict (user_id)
do update set plan = 'premium', updated_at = now();
```

To move an account back to the free tier:

```sql
update public.profiles
set plan = 'free', updated_at = now()
where user_id = 'user-uuid-here';
```

For this deployment, configure Supabase email confirmation redirects with:

```txt
Site URL:
https://music-translator-nine.vercel.app

Redirect URLs:
https://music-translator-nine.vercel.app/**
```

If email confirmation links say the site cannot be reached, check that the Supabase Site URL points to the deployed Vercel domain.

### Other Node Hosts

You can still use a Node web service host such as Render, Railway, or Fly.io. For Render, connect this repo and use:

```txt
Build Command: npm install
Start Command: npm start
```

The local Node server reads the host-provided `PORT` automatically.

## Translation

Romanization works in the browser. English translation starts automatically when lyrics are loaded or edited, using the local server. Without an OpenAI API key, the app falls back to MyMemory machine translation. With a key, OpenAI is used first and the fallback fills any missing lines.

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
