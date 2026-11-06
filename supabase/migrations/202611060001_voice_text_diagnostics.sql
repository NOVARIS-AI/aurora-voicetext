-- AURORA VoiceText operational diagnostics.
-- No audio, transcript text, contact details, or user account credentials are stored.
create table if not exists public.vt_installations (
  install_id text primary key,
  platform text not null default 'web',
  app_version text not null default 'unknown',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table if not exists public.vt_diagnostic_events (
  id bigint generated always as identity primary key,
  install_id text not null references public.vt_installations(install_id) on delete cascade,
  event_type text not null,
  feature text not null default 'app',
  severity text not null default 'info' check (severity in ('info','warning','error')),
  message text,
  app_version text not null default 'unknown',
  platform text not null default 'web',
  created_at timestamptz not null default now()
);
create index if not exists vt_events_created_at_idx on public.vt_diagnostic_events(created_at desc);
create index if not exists vt_events_install_id_idx on public.vt_diagnostic_events(install_id);
create index if not exists vt_events_severity_idx on public.vt_diagnostic_events(severity);
create table if not exists public.vt_bug_reports (
  id bigint generated always as identity primary key,
  install_id text not null references public.vt_installations(install_id) on delete cascade,
  description text not null,
  app_version text not null default 'unknown',
  platform text not null default 'web',
  page text,
  status text not null default 'open' check (status in ('open','investigating','resolved','closed')),
  created_at timestamptz not null default now()
);
alter table public.vt_installations enable row level security;
alter table public.vt_diagnostic_events enable row level security;
alter table public.vt_bug_reports enable row level security;
-- Access is server-side only through the Supabase service-role key in Vercel.
