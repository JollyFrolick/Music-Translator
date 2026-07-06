create table if not exists public.saved_translations (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  saved_at timestamptz not null default now(),
  language text not null check (language in ('mandarin', 'cantonese')),
  search_mode text not null check (search_mode in ('song', 'artist', 'custom')),
  search_query text not null default '',
  title text not null default '',
  artist text not null default '',
  lyrics text not null,
  translations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_translations_user_saved_at_idx
  on public.saved_translations (user_id, saved_at desc);

alter table public.saved_translations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_translations'
      and policyname = 'Users can read their saved translations'
  ) then
    create policy "Users can read their saved translations"
      on public.saved_translations
      for select
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_translations'
      and policyname = 'Users can create their saved translations'
  ) then
    create policy "Users can create their saved translations"
      on public.saved_translations
      for insert
      to authenticated
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_translations'
      and policyname = 'Users can update their saved translations'
  ) then
    create policy "Users can update their saved translations"
      on public.saved_translations
      for update
      to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_translations'
      and policyname = 'Users can delete their saved translations'
  ) then
    create policy "Users can delete their saved translations"
      on public.saved_translations
      for delete
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;
