-- AURORA VoiceText: durable recording and transcription job metadata.
-- Server-side API routes use the Supabase service-role key. Never expose it in the browser.
create extension if not exists pgcrypto;

create table if not exists public.voicetext_recordings (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_seconds numeric(12,3),
  storage_path text not null unique,
  status text not null default 'uploaded'
    check (status in ('created','uploading','uploaded','processing','completed','failed')),
  total_chunks integer not null default 0 check (total_chunks >= 0),
  completed_chunks integer not null default 0 check (completed_chunks >= 0),
  transcript text not null default '',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists voicetext_recordings_status_created_idx
  on public.voicetext_recordings (status, created_at desc);

alter table public.voicetext_recordings enable row level security;
-- Intentionally no anon/authenticated policies. Access is server-side only via service role.
