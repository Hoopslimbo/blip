-- Blip backend schema — run in the Supabase SQL editor (project zzsvqnnrfngfxtucszgr)

-- ---------- tables ----------
create table if not exists blip_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  created_at timestamptz default now()
);

create table if not exists blip_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references blip_profiles(id) on delete cascade,
  receiver_id uuid not null references blip_profiles(id) on delete cascade,
  body text,
  image_url text,
  created_at timestamptz default now(),
  check (body is not null or image_url is not null)
);

create table if not exists blip_stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references blip_profiles(id) on delete cascade,
  image_url text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

alter table blip_profiles enable row level security;
alter table blip_messages enable row level security;
alter table blip_stories enable row level security;

-- ---------- policies (re-runnable) ----------
drop policy if exists "blip_profiles_read" on blip_profiles;
create policy "blip_profiles_read" on blip_profiles for select using (true);

drop policy if exists "blip_profiles_insert" on blip_profiles;
create policy "blip_profiles_insert" on blip_profiles for insert with check (auth.uid() = id);

drop policy if exists "blip_profiles_update" on blip_profiles;
create policy "blip_profiles_update" on blip_profiles for update using (auth.uid() = id);

drop policy if exists "blip_messages_read" on blip_messages;
create policy "blip_messages_read" on blip_messages for select
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

drop policy if exists "blip_messages_insert" on blip_messages;
create policy "blip_messages_insert" on blip_messages for insert
  with check (auth.uid() = sender_id);

drop policy if exists "blip_stories_read" on blip_stories;
create policy "blip_stories_read" on blip_stories for select
  using (auth.role() = 'authenticated');

drop policy if exists "blip_stories_insert" on blip_stories;
create policy "blip_stories_insert" on blip_stories for insert
  with check (auth.uid() = user_id);

drop policy if exists "blip_stories_delete" on blip_stories;
create policy "blip_stories_delete" on blip_stories for delete
  using (auth.uid() = user_id);

-- ---------- realtime ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'blip_messages') then
    alter publication supabase_realtime add table blip_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'blip_stories') then
    alter publication supabase_realtime add table blip_stories;
  end if;
end $$;

-- ---------- storage ----------
insert into storage.buckets (id, name, public)
values ('blip-media', 'blip-media', true)
on conflict (id) do nothing;

drop policy if exists "blip_media_read" on storage.objects;
create policy "blip_media_read" on storage.objects for select
  using (bucket_id = 'blip-media');

drop policy if exists "blip_media_upload" on storage.objects;
create policy "blip_media_upload" on storage.objects for insert
  with check (bucket_id = 'blip-media' and auth.role() = 'authenticated');

drop policy if exists "blip_media_delete" on storage.objects;
create policy "blip_media_delete" on storage.objects for delete
  using (bucket_id = 'blip-media' and auth.role() = 'authenticated');
