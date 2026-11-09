-- Durable, private storage for AURORA VoiceText transcription jobs.
create extension if not exists pgcrypto;

create table if not exists public.voicetext_recordings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_seconds numeric(12,3),
  storage_path text not null unique,
  status text not null default 'created'
    check (status in ('created','uploading','uploaded','processing','completed','failed')),
  total_chunks integer not null default 0 check (total_chunks >= 0),
  completed_chunks integer not null default 0 check (completed_chunks >= 0),
  transcript text not null default '',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Safe for projects where the original table was already created.
alter table public.voicetext_recordings
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;
create index if not exists voicetext_recordings_status_created_idx
  on public.voicetext_recordings (status, created_at desc);
create index if not exists voicetext_recordings_owner_updated_idx
  on public.voicetext_recordings (owner_id, updated_at desc);

alter table public.voicetext_recordings enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voicetext-recordings',
  'voicetext-recordings',
  false,
  5242880,
  array['audio/wav','audio/x-wav','audio/mpeg','audio/mp3','audio/ogg','audio/mp4','audio/aac','audio/webm']
)
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = excluded.allowed_mime_types;
