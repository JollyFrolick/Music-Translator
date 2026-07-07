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

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.saved_translations enable row level security;
alter table public.profiles enable row level security;

create or replace function public.is_premium_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where target_user_id = auth.uid()
      and user_id = target_user_id
      and plan = 'premium'
  );
$$;

create or replace function public.saved_translation_count(target_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.saved_translations
  where target_user_id = auth.uid()
    and user_id = target_user_id;
$$;

create or replace function public.saved_translation_exists(target_user_id uuid, target_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.saved_translations
    where target_user_id = auth.uid()
      and user_id = target_user_id
      and id = target_id
  );
$$;

revoke all on function public.is_premium_user(uuid) from public;
revoke all on function public.saved_translation_count(uuid) from public;
revoke all on function public.saved_translation_exists(uuid, text) from public;
grant execute on function public.is_premium_user(uuid) to authenticated;
grant execute on function public.saved_translation_count(uuid) to authenticated;
grant execute on function public.saved_translation_exists(uuid, text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'Users can read their profile'
  ) then
    create policy "Users can read their profile"
      on public.profiles
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
      and policyname = 'Users can read their saved translations'
  ) then
    create policy "Users can read their saved translations"
      on public.saved_translations
      for select
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

drop policy if exists "Users can create their saved translations" on public.saved_translations;

create policy "Users can create their saved translations"
  on public.saved_translations
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and (
      public.is_premium_user(auth.uid())
      or public.saved_translation_count(auth.uid()) < 5
      or public.saved_translation_exists(auth.uid(), id)
    )
  );

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
